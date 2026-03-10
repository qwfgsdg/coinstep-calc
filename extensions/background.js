/**
 * Coinstep Tapbit Sync — Background Service Worker
 * 
 * 상태 머신: IDLE → OPENING_TABS → WAITING_DATA → SYNCED → AUTO_REFRESH
 */

// ── 상태 ──
let state = "IDLE";
let positionsTabId = null;
let accountsTabId = null;
let historiesTabId = null;
let autoRefreshTimer = null;
let autoRefreshEnabled = false;
const AUTO_REFRESH_INTERVAL = 30000; // 30초

// 데이터 수집 버퍼
let pending = {
  positions: null,
  accounts: null,
  profile: null,
  timeout: null,
};
let isFeeQuerying = false; // fee query 중 DATA_HISTORIES 저장 방지

// ── 메시지 핸들러 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // 팝업에서 동기화 시작
  if (msg.type === "SYNC_START") {
    startSync();
    sendResponse({ ok: true });
    return;
  }

  // 팝업에서 자동 갱신 토글
  if (msg.type === "SET_AUTO_REFRESH") {
    autoRefreshEnabled = msg.enabled;
    if (autoRefreshEnabled && state === "SYNCED") {
      startAutoRefresh();
    } else if (!autoRefreshEnabled) {
      stopAutoRefresh();
    }
    saveState();
    sendResponse({ ok: true });
    return;
  }

  // 팝업에서 동기화 중지
  if (msg.type === "SYNC_STOP") {
    stopAll();
    sendResponse({ ok: true });
    return;
  }

  // 팝업에서 상태 확인
  if (msg.type === "GET_STATUS") {
    chrome.storage.local.get(["tapbitData", "syncSettings"], (result) => {
      sendResponse({
        state,
        autoRefreshEnabled,
        lastSync: result?.tapbitData?.lastSync || null,
        userCount: result?.tapbitData?.positions?.length || 0,
        profile: result?.tapbitData?.profile || null,
        positionsTabId,
        accountsTabId,
        historiesTabId,
      });
    });
    return true; // 비동기
  }

  // content-tapbit에서 데이터 수신
  if (msg.type === "DATA_POSITIONS") {
    console.log("[BG] Positions received:", msg.data?.list?.length, "items");
    pending.positions = msg.data;
    checkDataComplete();
    return;
  }

  if (msg.type === "DATA_ACCOUNTS") {
    console.log("[BG] Accounts received:", msg.data?.list?.length, "items");
    pending.accounts = msg.data;
    checkDataComplete();
    return;
  }

  if (msg.type === "DATA_PROFILE") {
    pending.profile = msg.profile;
    return;
  }

  // histories 데이터 저장 (거래내역 — Coinstep에 전달용)
  if (msg.type === "DATA_HISTORIES") {
    const list = msg.data?.list || [];
    if (isFeeQuerying) {
      console.log("[BG] Histories received during fee query — skipping storage save (" + list.length + " items)");
      return;
    }
    console.log("[BG] Histories received:", list.length, "items — saving to storage");
    chrome.storage.local.set({
      tapbitHistories: {
        list: list,
        lastSync: Date.now(),
      },
    }, () => {
      console.log("[BG] Histories saved to chrome.storage.local");
    });
    return;
  }

  if (msg.type === "DATA_AUTH") {
    // auth 토큰 저장 (summary API 호출용)
    chrome.storage.local.set({
      tapbitAuth: { token: msg.auth, capturedAt: Date.now() },
    });
    console.log("[BG] Auth token saved");
    return;
  }

  // ── 수수료 요약 API 호출 (페이지네이션 지원) ──
  if (msg.type === "FETCH_SUMMARY") {
    const { startTime, endTime, userType } = msg;
    isFeeQuerying = true;

    // Tapbit historyOrders 탭 찾기
    const findTapbitTab = () => {
      return new Promise((resolve) => {
        const knownTab = historiesTabId || positionsTabId || accountsTabId;
        if (knownTab) {
          chrome.tabs.get(knownTab, (tab) => {
            if (chrome.runtime.lastError || !tab) {
              chrome.tabs.query({ url: "https://agent.tapbit.com/*" }, (tabs) => {
                resolve(tabs && tabs.length > 0 ? tabs.find(t => t.status === "complete") || tabs[0] : null);
              });
            } else {
              resolve(tab);
            }
          });
        } else {
          chrome.tabs.query({ url: "https://agent.tapbit.com/*" }, (tabs) => {
            resolve(tabs && tabs.length > 0 ? tabs.find(t => t.status === "complete") || tabs[0] : null);
          });
        }
      });
    };

    findTapbitTab().then((tab) => {
      if (!tab) {
        isFeeQuerying = false;
        sendResponse({ error: "NO_TAPBIT_TAB: Tapbit 탭이 없습니다. 동기화를 실행하세요." });
        return;
      }

      console.log("[BG] Fee query via dva dispatch: tab=" + tab.id, "dates:", startTime, "~", endTime);

      // Tapbit 페이지에서 모든 페이지의 /histories를 fetch하여 tradeFee 합산
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: (st, et) => {
          return new Promise((resolve) => {
            const allItems = [];
            let currentPage = 1;
            let totalExpected = -1;
            const PAGE_SIZE = 100;
            const MAX_PAGES = 50; // 안전 제한 (최대 5000건)

            const handler = (e) => {
              if (e.source !== window || e.data?.type !== "__TAPBIT_HISTORIES__") return;

              const data = e.data.data || {};
              const list = data.list || [];
              const page = data.page || {};

              console.log("[Coinstep] Page " + currentPage + " received: " + list.length + " items, total=" + page.total);

              // 아이템 누적
              list.forEach(item => allItems.push(item));

              // total 업데이트 (첫 페이지에서 설정)
              if (totalExpected < 0 && page.total >= 0) {
                totalExpected = page.total;
              }

              // 다음 페이지 필요 여부 확인 (total=-1인 API이므로 list.length로 판단)
              if (list.length === PAGE_SIZE && currentPage < MAX_PAGES) {
                // 다음 페이지 요청
                currentPage++;
                console.log("[Coinstep] Fetching page " + currentPage + " (total=" + totalExpected + ")");
                window.g_app._store.dispatch({
                  type: "lists/pageChange",
                  payload: {
                    id: "historyOrders",
                    page: { current: currentPage },
                  }
                });
              } else {
                // 모든 페이지 수집 완료
                window.removeEventListener("message", handler);
                clearTimeout(timeout);

                let totalFee = 0;
                const traders = new Set();
                allItems.forEach(item => {
                  totalFee += parseFloat(item.data?.tradeFee) || 0;
                  if (item.maskId) traders.add(item.maskId);
                });

                console.log("[Coinstep] All pages done: " + allItems.length + "/" + totalExpected + " items, fee=" + totalFee.toFixed(6));
                resolve({
                  data: {
                    totalCustomerTradeFees: totalFee.toString(),
                    totalCustomerTraders: traders.size,
                    recordCount: allItems.length,
                    totalRecords: totalExpected,
                  },
                  items: allItems,
                });
              }
            };
            window.addEventListener("message", handler);

            // 30초 타임아웃 (여러 페이지 fetch 시간 확보)
            const timeout = setTimeout(() => {
              window.removeEventListener("message", handler);
              if (allItems.length > 0) {
                // 부분 데이터라도 반환
                let totalFee = 0;
                const traders = new Set();
                allItems.forEach(item => {
                  totalFee += parseFloat(item.data?.tradeFee) || 0;
                  if (item.maskId) traders.add(item.maskId);
                });
                console.log("[Coinstep] Timeout with partial data: " + allItems.length + " items");
                resolve({
                  data: {
                    totalCustomerTradeFees: totalFee.toString(),
                    totalCustomerTraders: traders.size,
                    recordCount: allItems.length,
                    totalRecords: totalExpected,
                    partial: true,
                  },
                  items: allItems,
                });
              } else {
                resolve({ error: "TIMEOUT: 30초 내 응답 없음" });
              }
            }, 30000);

            // 1페이지: filtersChange dispatch
            console.log("[Coinstep] Dispatching filtersChange:", st, "~", et);
            window.g_app._store.dispatch({
              type: "lists/filtersChange",
              payload: {
                id: "historyOrders",
                filters: {
                  contractType: "USDT_MARGIN_CONTRACT",
                  startTime: String(st),
                  endTime: String(et),
                }
              }
            });
          });
        },
        args: [startTime, endTime],
      }).then((results) => {
        isFeeQuerying = false;
        const result = results?.[0]?.result;
        console.log("[BG] Fee query result:", JSON.stringify(result).substring(0, 300));
        if (result?.error) {
          sendResponse({ error: result.error });
        } else {
          sendResponse(result);
        }
      }).catch((e) => {
        isFeeQuerying = false;
        console.error("[BG] executeScript error:", e.message);
        sendResponse({ error: "EXEC_ERROR: " + e.message });
      });
    });
    return true; // 비동기 응답
  }

  if (msg.type === "TAB_LOADED") {
    console.log("[BG] Tab loaded:", msg.url);
    // inject 삽입 완료 후 Refresh 클릭 (API 재호출)
    const tabId = sender.tab?.id;
    if (tabId && (state === "WAITING_DATA" || state === "OPENING_TABS")) {
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: "CLICK_REFRESH" }).catch(() => {});
        console.log("[BG] Auto-refresh sent to tab:", tabId);
      }, 2000); // 2초 대기 (페이지 렌더링 완료 대기)
    }
    return;
  }

  return false;
});

// ── 동기화 시작 ──
async function startSync() {
  console.log("[BG] Starting sync...");
  state = "OPENING_TABS";
  pending = { positions: null, accounts: null, profile: null, timeout: null };
  broadcastState();

  try {
    // 기존 탭이 있으면 재사용, 없으면 새로 열기
    const posTid = await ensureTab(positionsTabId, "https://agent.tapbit.com/contract/positions/perpetual");
    const accTid = await ensureTab(accountsTabId, "https://agent.tapbit.com/contract/profits");
    const hisTid = await ensureTab(historiesTabId, "https://agent.tapbit.com/contract/historyOrders/perpetual");
    positionsTabId = posTid;
    accountsTabId = accTid;
    historiesTabId = hisTid;

    state = "WAITING_DATA";
    broadcastState();

    // 15초 타임아웃
    pending.timeout = setTimeout(() => {
      if (state === "WAITING_DATA") {
        console.log("[BG] Timeout — saving partial data");
        mergeAndSave();
      }
    }, 15000);

  } catch (e) {
    console.error("[BG] Sync error:", e);
    state = "IDLE";
    broadcastState();
  }
}

// ── 탭 열기/재사용 ──
async function ensureTab(existingId, url) {
  // 기존 탭 확인
  if (existingId) {
    try {
      const tab = await chrome.tabs.get(existingId);
      // 같은 도메인이면 URL 이동
      if (tab.url.includes("agent.tapbit.com")) {
        await chrome.tabs.update(existingId, { url, active: false });
        return existingId;
      }
    } catch (e) { /* 탭 없음 — 새로 열기 */ }
  }

  // 새 탭 열기 (백그라운드)
  const tab = await chrome.tabs.create({ url, active: false });
  return tab.id;
}

// ── 데이터 수집 완료 체크 ──
function checkDataComplete() {
  if (pending.positions && pending.accounts) {
    // 둘 다 도착
    clearTimeout(pending.timeout);
    mergeAndSave();
  } else if (state === "AUTO_REFRESH" && (pending.positions || pending.accounts)) {
    // 자동 갱신 중에는 하나만 와도 부분 저장
    // 3초 대기 후 나머지 안 오면 있는 것만 저장
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => mergeAndSave(), 3000);
  }
}

// ── 데이터 합치기 + 저장 ──
async function mergeAndSave() {
  clearTimeout(pending.timeout);

  const prev = await chrome.storage.local.get("tapbitData");
  const prevData = prev?.tapbitData || {};

  const merged = {
    positions: pending.positions?.list || prevData.positions || [],
    accounts: pending.accounts?.list || prevData.accounts || [],
    profile: pending.profile || prevData.profile || null,
    lastSync: Date.now(),
    version: (prevData.version || 0) + 1,
  };

  await chrome.storage.local.set({ tapbitData: merged });
  console.log("[BG] Data saved — positions:", merged.positions.length, "accounts:", merged.accounts.length);

  // 상태 전환
  pending.positions = null;
  pending.accounts = null;

  if (autoRefreshEnabled) {
    state = "AUTO_REFRESH";
    startAutoRefresh();
  } else {
    state = "SYNCED";
  }
  broadcastState();
  saveState();
}

// ── 자동 갱신 ──
function startAutoRefresh() {
  stopAutoRefresh();
  console.log("[BG] Auto-refresh started (30s interval)");
  autoRefreshTimer = setInterval(() => doRefresh(), AUTO_REFRESH_INTERVAL);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

async function doRefresh() {
  // 탭 존재 확인
  try {
    if (positionsTabId) await chrome.tabs.get(positionsTabId);
    if (accountsTabId) await chrome.tabs.get(accountsTabId);
    if (historiesTabId) await chrome.tabs.get(historiesTabId);
  } catch (e) {
    console.log("[BG] Tab closed — stopping auto-refresh");
    stopAll();
    return;
  }

  console.log("[BG] Auto-refresh — clicking Refresh buttons");
  pending.positions = null;
  pending.accounts = null;
  state = "AUTO_REFRESH";

  // 타임아웃: 10초
  pending.timeout = setTimeout(() => mergeAndSave(), 10000);

  // 각 탭에 Refresh 클릭 요청
  if (positionsTabId) {
    chrome.tabs.sendMessage(positionsTabId, { type: "CLICK_REFRESH" }).catch(() => {});
  }
  if (accountsTabId) {
    chrome.tabs.sendMessage(accountsTabId, { type: "CLICK_REFRESH" }).catch(() => {});
  }
  if (historiesTabId) {
    chrome.tabs.sendMessage(historiesTabId, { type: "CLICK_REFRESH" }).catch(() => {});
  }
}

// ── 전체 중지 ──
function stopAll() {
  stopAutoRefresh();
  clearTimeout(pending.timeout);
  state = "IDLE";
  pending = { positions: null, accounts: null, profile: null, timeout: null };
  broadcastState();
  saveState();
}

// ── 탭 닫힘 감지 ──
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === positionsTabId) {
    positionsTabId = null;
    console.log("[BG] Positions tab closed");
  }
  if (tabId === accountsTabId) {
    accountsTabId = null;
    console.log("[BG] Accounts tab closed");
  }
  if (tabId === historiesTabId) {
    historiesTabId = null;
    console.log("[BG] Histories tab closed");
  }
  // 모두 닫히면 중지
  if (!positionsTabId && !accountsTabId && !historiesTabId && state !== "IDLE") {
    stopAll();
  }
});

// ── 상태 브로드캐스트 (팝업에) ──
function broadcastState() {
  chrome.runtime.sendMessage({
    type: "STATE_UPDATE",
    state,
    autoRefreshEnabled,
  }).catch(() => {}); // 팝업 안 열려있으면 에러 무시
}

// ── 설정 저장/복원 ──
function saveState() {
  chrome.storage.local.set({
    syncSettings: { autoRefreshEnabled },
  });
}

// 시작 시 설정 복원
chrome.storage.local.get("syncSettings", (result) => {
  if (result?.syncSettings) {
    autoRefreshEnabled = result.syncSettings.autoRefreshEnabled || false;
  }
});
