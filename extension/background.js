/**
 * Coinstep Tapbit Sync — Background Service Worker
 * 
 * 상태 머신: IDLE → OPENING_TABS → WAITING_DATA → SYNCED → AUTO_REFRESH
 */

// ── 상태 ──
let state = "IDLE";
let positionsTabId = null;
let accountsTabId = null;
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

  if (msg.type === "DATA_AUTH") {
    // auth는 로그인 여부 확인용으로만 사용
    return;
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
    positionsTabId = posTid;
    accountsTabId = accTid;

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
  // 둘 다 닫히면 중지
  if (!positionsTabId && !accountsTabId && state !== "IDLE") {
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
