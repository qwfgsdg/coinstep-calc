/**
 * inject-tapbit.js — Tapbit 페이지 컨텍스트에서 실행
 * 
 * 역할: 페이지의 fetch 호출을 감시하여 auth 토큰을 캡처
 * 이 스크립트는 web_accessible_resources로 페이지에 삽입됨
 */

(function() {
  "use strict";

  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    const result = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      
      // agent-api.tapbit.com 호출에서 auth 파라미터 캡처
      if (url.includes("agent-api.tapbit.com") && url.includes("auth=")) {
        const authMatch = url.match(/auth=([^&]+)/);
        if (authMatch) {
          window.postMessage({
            type: "__TAPBIT_AUTH__",
            auth: authMatch[1],
          }, "*");
        }
      }

      // 프로필 API 응답 캡처
      if (url.includes("/agent/profile")) {
        try {
          const cloned = result.clone();
          const data = await cloned.json();
          if (data?.data?.maskId) {
            window.postMessage({
              type: "__TAPBIT_PROFILE__",
              profile: {
                maskId: data.data.maskId,
                remarkName: data.data.remarkName || "",
                type: data.data.type || "",
              },
            }, "*");
          }
        } catch (e) { /* 파싱 에러 무시 */ }
      }
    } catch (e) { /* 감시 에러 무시 — 원본 fetch에 영향 없음 */ }

    return result;
  };

  // XMLHttpRequest도 감시 (혹시 XHR 사용 시)
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._tapbitUrl = url;
    return originalXHROpen.call(this, method, url, ...rest);
  };

  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener("load", function() {
      try {
        const url = this._tapbitUrl || "";
        if (url.includes("agent-api.tapbit.com") && url.includes("auth=")) {
          const authMatch = url.match(/auth=([^&]+)/);
          if (authMatch) {
            window.postMessage({
              type: "__TAPBIT_AUTH__",
              auth: authMatch[1],
            }, "*");
          }
        }
      } catch (e) { /* 무시 */ }
    });
    return originalXHRSend.apply(this, args);
  };

  console.log("[Coinstep] Tapbit fetch monitor active");
})();
