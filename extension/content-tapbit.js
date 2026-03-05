/**
 * content-tapbit.js — agent.tapbit.com에 주입되는 content script
 * 
 * 역할:
 * 1. inject-tapbit.js를 페이지 컨텍스트에 삽입
 * 2. 캡처된 데이터를 background.js로 중계
 * 3. CLICK_REFRESH 요청 시 Refresh 버튼 자동 클릭
 */

(function() {
  "use strict";

  // ── inject-tapbit.js를 페이지 컨텍스트에 삽입 ──
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject-tapbit.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // ── inject에서 보내는 메시지를 background로 중계 ──
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const type = e.data?.type;

    if (type === "__TAPBIT_AUTH__") {
      chrome.runtime.sendMessage({
        type: "DATA_AUTH",
        auth: e.data.auth,
      }).catch(() => {});
    }

    if (type === "__TAPBIT_POSITIONS__") {
      chrome.runtime.sendMessage({
        type: "DATA_POSITIONS",
        data: e.data.data,
      }).catch(() => {});
    }

    if (type === "__TAPBIT_ACCOUNTS__") {
      chrome.runtime.sendMessage({
        type: "DATA_ACCOUNTS",
        data: e.data.data,
      }).catch(() => {});
    }

    if (type === "__TAPBIT_PROFILE__") {
      chrome.runtime.sendMessage({
        type: "DATA_PROFILE",
        profile: e.data.profile,
      }).catch(() => {});
    }
  });

  // ── background에서 보내는 명령 수신 ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    // Refresh 버튼 자동 클릭
    if (msg.type === "CLICK_REFRESH") {
      const tryClick = (retries) => {
        const icon = document.querySelector(".anticon-reload");
        const btn = icon ? (icon.closest("button") || icon.parentElement) : null;
        if (btn) {
          btn.click();
          sendResponse({ ok: true });
        } else if (retries < 10) {
          setTimeout(() => tryClick(retries + 1), 500);
        } else {
          sendResponse({ ok: false, error: "BUTTON_NOT_FOUND" });
        }
      };
      tryClick(0);
      return true; // 비동기 응답
    }

    // 페이지 로드 완료 확인
    if (msg.type === "CHECK_PAGE_READY") {
      sendResponse({ ready: true, url: window.location.href });
    }
  });

  // ── 로드 완료 알림 ──
  chrome.runtime.sendMessage({ type: "TAB_LOADED", url: window.location.href }).catch(() => {});

  console.log("[Coinstep] Tapbit content script loaded");
})();
