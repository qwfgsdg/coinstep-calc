/**
 * Coinstep Tapbit Sync — Background Service Worker
 * 
 * 역할:
 * 1. Tapbit 탭의 auth 토큰 캐싱
 * 2. 계산기 ↔ Tapbit 탭 간 메시지 라우팅
 * 3. 연결 상태 관리
 */

let cachedAuth = null;
let tapbitTabId = null;
let agentProfile = null; // { maskId, remarkName }

// ── 메시지 핸들러 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Tapbit 탭에서 auth 캡처됨
  if (msg.type === "AUTH_CAPTURED") {
    cachedAuth = msg.auth;
    tapbitTabId = sender.tab?.id || null;
    console.log("[BG] Auth captured from tab:", tapbitTabId);
    sendResponse({ ok: true });
    return;
  }

  // Tapbit 탭에서 프로필 정보 캡처됨
  if (msg.type === "PROFILE_CAPTURED") {
    agentProfile = msg.profile;
    console.log("[BG] Profile:", agentProfile?.remarkName);
    sendResponse({ ok: true });
    return;
  }

  // 계산기에서 연결 상태 확인
  if (msg.type === "CHECK_STATUS") {
    sendResponse({
      connected: !!cachedAuth && !!tapbitTabId,
      profile: agentProfile,
      tabId: tapbitTabId,
    });
    return;
  }

  // 계산기에서 동기화 요청
  if (msg.type === "SYNC_REQUEST") {
    handleSyncRequest(sendResponse);
    return true; // 비동기 응답
  }

  return false;
});

// ── 동기화 요청 처리 ──
async function handleSyncRequest(sendResponse) {
  if (!tapbitTabId) {
    sendResponse({ error: "NO_TAB", message: "Tapbit 관리자 페이지를 열어주세요" });
    return;
  }

  // Tapbit 탭이 아직 존재하는지 확인
  try {
    await chrome.tabs.get(tapbitTabId);
  } catch (e) {
    tapbitTabId = null;
    cachedAuth = null;
    sendResponse({ error: "TAB_CLOSED", message: "Tapbit 탭이 닫혔습니다. 다시 열어주세요" });
    return;
  }

  // Tapbit 탭의 content script에 데이터 요청
  try {
    chrome.tabs.sendMessage(tapbitTabId, { type: "FETCH_DATA" }, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ 
          error: "COMM_ERROR", 
          message: "Tapbit 페이지와 통신 실패 — 페이지를 새로고침해주세요" 
        });
        return;
      }
      sendResponse(response);
    });
  } catch (e) {
    sendResponse({ error: "SEND_ERROR", message: e.message });
  }
}

// ── 탭 닫힘 감지 ──
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === tapbitTabId) {
    tapbitTabId = null;
    cachedAuth = null;
    console.log("[BG] Tapbit tab closed");
  }
});

// ── 탭 URL 변경 감지 (로그아웃 등) ──
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === tapbitTabId && changeInfo.url) {
    // agent.tapbit.com이 아닌 페이지로 이동하면 연결 해제
    if (!changeInfo.url.includes("agent.tapbit.com")) {
      tapbitTabId = null;
      cachedAuth = null;
      console.log("[BG] Tapbit tab navigated away");
    }
  }
});
