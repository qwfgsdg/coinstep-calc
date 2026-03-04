/**
 * content-calc.js — calc.coinstep.co.kr에 주입되는 content script
 * 
 * 역할:
 * 1. 계산기 앱에 확장 존재를 알림
 * 2. 계산기 ↔ background.js 메시지 중계
 */

(function() {
  "use strict";

  // ── 확장 존재 알림 ──
  window.dispatchEvent(new CustomEvent("tapbit-extension-ready"));

  // ── 계산기에서 보내는 메시지 수신 ──
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;

    // 동기화 요청
    if (e.data?.type === "CALC_SYNC_REQUEST") {
      chrome.runtime.sendMessage({ type: "SYNC_REQUEST" }, (response) => {
        if (chrome.runtime.lastError) {
          window.dispatchEvent(new CustomEvent("tapbit-sync-response", {
            detail: { error: "EXTENSION_ERROR", message: "확장 프로그램 오류 — 새로고침해주세요" },
          }));
          return;
        }
        window.dispatchEvent(new CustomEvent("tapbit-sync-response", {
          detail: response,
        }));
      });
    }

    // 상태 확인
    if (e.data?.type === "CALC_CHECK_STATUS") {
      chrome.runtime.sendMessage({ type: "CHECK_STATUS" }, (response) => {
        if (chrome.runtime.lastError) return;
        window.dispatchEvent(new CustomEvent("tapbit-status-response", {
          detail: response,
        }));
      });
    }
  });

  // ── 주기적 상태 확인 (30초마다) ──
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "CHECK_STATUS" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.connected) {
        window.dispatchEvent(new CustomEvent("tapbit-extension-ready"));
      }
    });
  }, 30000);

  console.log("[Coinstep] Calculator content script loaded");
})();
