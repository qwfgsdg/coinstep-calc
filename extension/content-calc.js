/**
 * content-calc.js — pro.coinstep.co.kr에 주입되는 content script
 * 
 * 역할:
 * 1. 확장 존재 알림
 * 2. chrome.storage 변경 감지 → 계산기에 이벤트 발행
 * 3. 수동 동기화 요청 중계 (하위 호환)
 */

(function() {
  "use strict";

  // ── 확장 존재 알림 ──
  window.dispatchEvent(new CustomEvent("tapbit-extension-ready"));

  // ── chrome.storage 변경 감지 → 계산기에 이벤트 발행 ──
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.tapbitData) {
      const newData = changes.tapbitData.newValue;
      if (!newData) return;

      window.dispatchEvent(new CustomEvent("tapbit-sync-response", {
        detail: {
          success: true,
          positions: newData.positions || [],
          accounts: newData.accounts || [],
          profile: newData.profile || null,
          lastSync: newData.lastSync,
          version: newData.version,
        },
      }));

      console.log("[Coinstep] Sync data updated — v" + newData.version);
    }
  });

  // ── 초기 로드 시 기존 데이터 전달 ──
  chrome.storage.local.get("tapbitData", (result) => {
    const data = result?.tapbitData;
    if (data && data.positions?.length > 0) {
      window.dispatchEvent(new CustomEvent("tapbit-sync-response", {
        detail: {
          success: true,
          positions: data.positions || [],
          accounts: data.accounts || [],
          profile: data.profile || null,
          lastSync: data.lastSync,
          version: data.version,
        },
      }));
      console.log("[Coinstep] Initial data loaded from storage");
    }
  });

  // ── 수동 동기화 요청 중계 (기존 호환) ──
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;

    if (e.data?.type === "CALC_SYNC_REQUEST") {
      // 기존 storage 데이터가 있으면 즉시 전달
      chrome.storage.local.get("tapbitData", (result) => {
        const data = result?.tapbitData;
        if (data && data.positions?.length > 0) {
          window.dispatchEvent(new CustomEvent("tapbit-sync-response", {
            detail: {
              success: true,
              positions: data.positions,
              accounts: data.accounts || [],
              profile: data.profile || null,
              lastSync: data.lastSync,
              version: data.version,
            },
          }));
        }
      });

      // 새 동기화도 시작 (최신 데이터 갱신)
      chrome.runtime.sendMessage({ type: "SYNC_START" }, (response) => {
        if (chrome.runtime.lastError) {
          window.dispatchEvent(new CustomEvent("tapbit-sync-response", {
            detail: { error: "EXTENSION_ERROR", message: "확장 프로그램 오류" },
          }));
        }
      });
    }

    if (e.data?.type === "CALC_CHECK_STATUS") {
      chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
        if (chrome.runtime.lastError) return;
        window.dispatchEvent(new CustomEvent("tapbit-status-response", {
          detail: response,
        }));
      });
    }
  });

  // ── 주기적 확장 존재 알림 (30초마다) ──
  setInterval(() => {
    window.dispatchEvent(new CustomEvent("tapbit-extension-ready"));
  }, 30000);

  console.log("[Coinstep] Calculator content script loaded");
})();
