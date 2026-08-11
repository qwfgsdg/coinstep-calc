/**
 * Coinstep Tapbit Sync — Background Service Worker
 *
 * ── 설계 원칙 ──
 * MV3 서비스 워커는 30초쯤 놀면 크롬이 종료한다. 그래서 탭 id 나 상태를
 * 메모리 변수에 들고 있으면 다음 호출 때 전부 null 이 되어 있다.
 * (이게 "동기화 후 시간이 지나면 수수료 조회가 실패하던" 원인이었다 —
 *  탭 id 를 잃고 아무 tapbit 탭이나 골라서, 목록이 없는 페이지에 명령을 내렸다.)
 *
 * → 상태를 들지 않는다. 필요할 때마다 URL 로 탭을 찾는다.
 * → 갱신은 DOM 새로고침 버튼 클릭 대신 앱 스토어에 직접 명령한다.
 *   (Tapbit 이 화면을 바꿔도 안 깨지고, 페이지 크기도 우리가 정할 수 있다.)
 * → 주기 실행은 coinstep 페이지가 트리거한다. 워커의 setInterval 은 못 믿는다.
 */

const ROUTES = {
  positions: {
    match: "https://agent.tapbit.com/contract/positions/*",
    url: "https://agent.tapbit.com/contract/positions/perpetual",
    pathKey: "positions", listId: "positions", msgType: "__TAPBIT_POSITIONS__",
  },
  accounts: {
    match: "https://agent.tapbit.com/contract/profits*",
    url: "https://agent.tapbit.com/contract/profits",
    pathKey: "profits", listId: "profits", msgType: "__TAPBIT_ACCOUNTS__",
  },
  histories: {
    match: "https://agent.tapbit.com/contract/historyOrders/*",
    url: "https://agent.tapbit.com/contract/historyOrders/perpetual",
    pathKey: "historyOrders", listId: "historyOrders", msgType: "__TAPBIT_HISTORIES__",
  },
};

const WANT_PAGE_SIZE = 100;   // Tapbit UI 가 제공하는 최대치
const MAX_PAGES = 50;
const COLLECT_TIMEOUT_MS = 25000;
const MIN_SYNC_GAP_MS = 5000; // coinstep 탭이 여러 개 열려도 중복 호출 방지

let syncInFlight = false;
let lastSyncAt = 0;
let isFeeQuerying = false;

/* ═══════════════════════════════════════════
   페이지 안에서 실행되는 수집기 (MAIN world)
   executeScript 로 넘기므로 바깥 스코프를 참조하면 안 된다.
   ═══════════════════════════════════════════ */
function pageCollector(listId, pathKey, msgType, filters, wantSize, maxPages, timeoutMs) {
  return new Promise((resolve) => {
    // 경로 확인. 스토어 키만 보면 안 된다 — SPA 라 이전 라우트의 목록이 남아 있는데,
    // 그 상태에서 명령을 내리면 요청이 안 나가고 조용히 무시된다.
    if (location.pathname.indexOf(pathKey) < 0) {
      resolve({ error: "WRONG_PAGE", detail: location.pathname });
      return;
    }
    const app = window.g_app;
    if (!app || !app._store) { resolve({ error: "NO_STORE" }); return; }
    const L = () => (app._store.getState().lists || {})[listId];
    if (!L()) { resolve({ error: "NO_LIST", detail: listId }); return; }

    const curSize = (L().page && L().page.size) || 10;
    const size = Math.max(curSize, wantSize);

    const all = [];
    let page = 1, finished = false, timer = null;

    const done = (extra) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(Object.assign({ items: all, pages: page, size }, extra || {}));
    };

    const onMsg = (e) => {
      if (e.source !== window || !e.data || e.data.type !== msgType) return;
      const list = (e.data.data && e.data.data.list) || [];
      all.push.apply(all, list);
      // 이 API 는 전체 건수를 안 준다(total: -1). 한 페이지가 꽉 찼으면 더 있다고 본다.
      if (list.length === size && page < maxPages) {
        page++;
        app._store.dispatch({ type: "lists/pageChange", payload: { id: listId, page: { current: page } } });
      } else {
        done();
      }
    };

    const start = () => {
      window.addEventListener("message", onMsg);
      timer = setTimeout(() => done({ partial: true, reason: "TIMEOUT" }), timeoutMs);
      if (filters) {
        app._store.dispatch({ type: "lists/filtersChange", payload: { id: listId, filters } });
      } else {
        app._store.dispatch({ type: "lists/pageChange", payload: { id: listId, page: { current: 1 } } });
      }
    };

    if (curSize !== size) {
      // 크기 변경도 요청을 한 번 발생시킨다. 그 응답을 세지 않도록
      // 리스너를 붙이기 전에 먼저 보내고 잠시 기다린다.
      app._store.dispatch({ type: "lists/pageChange", payload: { id: listId, page: { current: 1, size } } });
      setTimeout(start, 1200);
    } else {
      start();
    }
  });
}

/* ═══════════════════════════════════════════
   탭 찾기 / 수집
   ═══════════════════════════════════════════ */
async function findTab(kind, create) {
  const r = ROUTES[kind];
  const tabs = await chrome.tabs.query({ url: r.match });
  const ready = tabs.find((t) => t.status === "complete") || tabs[0];
  if (ready) return ready;
  if (!create) return null;
  return await chrome.tabs.create({ url: r.url, active: false });
}

function waitComplete(tabId, ms) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const poll = () => {
      chrome.tabs.get(tabId).then((t) => {
        if (t.status === "complete") resolve(true);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(poll, 500);
      }).catch(() => resolve(false));
    };
    poll();
  });
}

async function collect(kind, filters, opts) {
  const o = opts || {};
  const r = ROUTES[kind];
  const tab = await findTab(kind, !!o.create);
  if (!tab) return { error: "NO_TAB", detail: kind };
  await waitComplete(tab.id, 15000);

  const run = async () => {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: "MAIN",
      func: pageCollector,
      args: [r.listId, r.pathKey, r.msgType, filters || null, WANT_PAGE_SIZE, MAX_PAGES, COLLECT_TIMEOUT_MS],
    });
    return (res && res[0] && res[0].result) || { error: "NO_RESULT" };
  };

  try {
    let out = await run();
    // 방금 연 탭이면 SPA 가 아직 부팅 중일 수 있다. 한 번만 더 준다.
    if (out.error === "NO_STORE" || out.error === "NO_LIST") {
      await new Promise((r2) => setTimeout(r2, 2500));
      out = await run();
    }
    // 응답이 하나도 없다 = 이 탭에 fetch 후킹이 안 붙어 있다.
    // 확장이 업데이트되면 그전부터 열려 있던 탭은 콘텐츠 스크립트가 끊긴다.
    // 탭을 한 번 새로고침하면 다시 붙는다.
    if (out.partial && (!out.items || out.items.length === 0)) {
      await chrome.tabs.reload(tab.id);
      await waitComplete(tab.id, 20000);
      await new Promise((r2) => setTimeout(r2, 2500));
      out = await run();
      if (out.partial && (!out.items || out.items.length === 0)) out = { error: "TIMEOUT" };
    }
    return out;
  } catch (e) {
    return { error: "EXEC", detail: e.message };
  }
}

const ERR_TEXT = {
  NO_TAB: "Tapbit 탭이 없습니다 — 확장에서 동기화를 실행하세요",
  WRONG_PAGE: "Tapbit 탭이 다른 화면에 있습니다",
  NO_STORE: "Tapbit 페이지가 아직 로딩 중입니다",
  NO_LIST: "Tapbit 페이지에서 목록을 찾지 못했습니다",
  TIMEOUT: "Tapbit 응답이 없습니다 — 로그인이 만료됐을 수 있습니다",
  EXEC: "Tapbit 탭에 접근하지 못했습니다",
  NO_RESULT: "Tapbit 탭에서 결과를 받지 못했습니다",
};
const describe = (e) => ERR_TEXT[e] || ("동기화 실패 (" + e + ")");

async function setStatus(ok, message, extra) {
  await chrome.storage.local.set({
    tapbitSyncStatus: Object.assign({ ok: !!ok, message: message || null, at: Date.now() }, extra || {}),
  });
}

/* ═══════════════════════════════════════════
   동기화
   ═══════════════════════════════════════════ */
async function doSync(opts) {
  const o = opts || {};
  if (syncInFlight) return { skipped: "IN_FLIGHT" };
  if (!o.force && Date.now() - lastSyncAt < MIN_SYNC_GAP_MS) return { skipped: "TOO_SOON" };
  syncInFlight = true;
  try {
    const [pos, acc] = await Promise.all([
      collect("positions", null, { create: !!o.create }),
      collect("accounts", null, { create: !!o.create }),
    ]);
    const posOk = pos && !pos.error;
    const accOk = acc && !acc.error;

    if (!posOk && !accOk) {
      const err = (pos && pos.error) || (acc && acc.error) || "NO_RESULT";
      await setStatus(false, describe(err));
      return { ok: false, error: err };
    }

    const prev = (await chrome.storage.local.get("tapbitData")).tapbitData || {};
    const merged = {
      // 성공한 쪽만 갱신한다. 실패한 쪽을 빈 배열로 덮으면 화면에서 포지션이 사라진다.
      positions: posOk ? pos.items : (prev.positions || []),
      accounts: accOk ? acc.items : (prev.accounts || []),
      profile: prev.profile || null,
      lastSync: Date.now(),
      version: (prev.version || 0) + 1,
    };
    await chrome.storage.local.set({ tapbitData: merged });
    lastSyncAt = Date.now();

    const partial = !posOk || !accOk || pos.partial || acc.partial;
    await setStatus(!partial, partial ? describe((pos && pos.error) || (acc && acc.error) || "TIMEOUT") : null, {
      positions: merged.positions.length, accounts: merged.accounts.length,
    });
    return { ok: true, positions: merged.positions.length, accounts: merged.accounts.length, partial: !!partial };
  } catch (e) {
    await setStatus(false, "동기화 중 오류: " + e.message);
    return { ok: false, error: "EXCEPTION", detail: e.message };
  } finally {
    syncInFlight = false;
  }
}

/* ═══════════════════════════════════════════
   메시지 핸들러
   ═══════════════════════════════════════════ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // 팝업: 수동 동기화 (탭이 없으면 새로 연다)
  if (msg.type === "SYNC_START") {
    doSync({ create: true, force: true }).then((r) => sendResponse(r));
    return true;
  }

  // coinstep 페이지: 15초 자동 동기화 (탭을 새로 열지는 않는다)
  if (msg.type === "AUTO_SYNC") {
    chrome.storage.local.get("syncSettings").then((s) => {
      if (s && s.syncSettings && s.syncSettings.autoRefreshEnabled === false) {
        sendResponse({ skipped: "DISABLED" });
        return;
      }
      doSync({ create: false }).then((r) => sendResponse(r));
    });
    return true;
  }

  if (msg.type === "SET_AUTO_REFRESH") {
    chrome.storage.local.set({ syncSettings: { autoRefreshEnabled: !!msg.enabled } });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "SYNC_STOP") {
    chrome.storage.local.set({ syncSettings: { autoRefreshEnabled: false } });
    setStatus(false, "자동 동기화를 껐습니다");
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "GET_STATUS") {
    Promise.all([
      chrome.storage.local.get(["tapbitData", "syncSettings", "tapbitSyncStatus"]),
      chrome.tabs.query({ url: "https://agent.tapbit.com/*" }),
    ]).then(([res, tabs]) => {
      const auto = !(res.syncSettings && res.syncSettings.autoRefreshEnabled === false);
      const has = tabs.length > 0;
      const st = res.tapbitSyncStatus || {};
      sendResponse({
        state: !has ? "IDLE" : (syncInFlight ? "WAITING_DATA" : (auto ? "AUTO_REFRESH" : "SYNCED")),
        autoRefreshEnabled: auto,
        lastSync: (res.tapbitData && res.tapbitData.lastSync) || null,
        userCount: (res.tapbitData && res.tapbitData.positions && res.tapbitData.positions.length) || 0,
        profile: (res.tapbitData && res.tapbitData.profile) || null,
        tapbitTabs: tabs.length,
        lastError: st.ok === false ? st.message : null,
      });
    });
    return true;
  }

  // inject 가 잡아준 데이터 (탭을 사람이 직접 조작했을 때도 최신값이 들어온다)
  if (msg.type === "DATA_PROFILE") {
    chrome.storage.local.get("tapbitData").then((r) => {
      const d = r.tapbitData || {};
      d.profile = msg.profile;
      chrome.storage.local.set({ tapbitData: d });
    });
    return;
  }

  if (msg.type === "DATA_HISTORIES") {
    if (isFeeQuerying) return;   // 수수료 조회 중에는 중간 페이지를 저장하지 않는다
    const list = (msg.data && msg.data.list) || [];
    chrome.storage.local.set({ tapbitHistories: { list, lastSync: Date.now() } });
    return;
  }

  // auth 는 요청마다 새로 만들어지는 일회용 서명이라 저장해도 재사용할 수 없다.
  // (직접 호출을 시도하면 서버가 "Restricted access" 로 거부한다.)
  // 하위 호환을 위해 메시지는 받아주되 무시한다.
  if (msg.type === "DATA_AUTH" || msg.type === "DATA_POSITIONS" || msg.type === "DATA_ACCOUNTS") return;

  // 수수료 요약 — 거래내역 탭을 URL 로 정확히 찾아서 조회한다
  if (msg.type === "FETCH_SUMMARY") {
    const { startTime, endTime } = msg;
    if (!(startTime < endTime)) {
      sendResponse({ error: "BAD_RANGE", message: "시작일이 종료일보다 늦습니다" });
      return true;
    }
    isFeeQuerying = true;
    collect("histories", {
      contractType: "USDT_MARGIN_CONTRACT",
      startTime: String(startTime),
      endTime: String(endTime),
    }, { create: true }).then((out) => {
      isFeeQuerying = false;
      if (out.error) {
        sendResponse({ error: out.error, message: describe(out.error) });
        return;
      }
      let fee = 0;
      const traders = new Set();
      out.items.forEach((it) => {
        fee += parseFloat((it.data && it.data.tradeFee) || 0) || 0;
        if (it.maskId) traders.add(it.maskId);
      });
      sendResponse({
        data: {
          totalCustomerTradeFees: fee.toString(),
          totalCustomerTraders: traders.size,
          recordCount: out.items.length,
          totalRecords: out.items.length,
          partial: !!out.partial,
        },
        items: out.items,
      });
    }).catch((e) => {
      isFeeQuerying = false;
      sendResponse({ error: "EXEC", message: "조회 중 오류: " + e.message });
    });
    return true;
  }

  if (msg.type === "TAB_LOADED") return;

  return false;
});
