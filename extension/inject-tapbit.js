/**
 * inject-tapbit.js — Tapbit 페이지 컨텍스트에서 실행
 * 
 * 역할: fetch 응답을 가로채서 positions/accounts/profile 데이터 캡처
 */

(function() {
  "use strict";

  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    const result = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

      if (!url.includes("agent-api.tapbit.com")) return result;

      // auth 캡처 (모든 agent-api 요청에서)
      const authMatch = url.match(/auth=([^&]+)/);
      if (authMatch) {
        window.postMessage({ type: "__TAPBIT_AUTH__", auth: authMatch[1] }, "*");
      }

      // positions 응답 캡처
      if (url.includes("/agent/contract/positions") && url.includes("contractType=")) {
        try {
          const cloned = result.clone();
          const data = await cloned.json();
          console.log("[Coinstep] Positions API intercepted:", url.substring(0, 80), "code:", data?.code, "list:", data?.data?.list?.length);
          if (data?.data?.list) {
            window.postMessage({
              type: "__TAPBIT_POSITIONS__",
              data: data.data,
            }, "*");
          }
        } catch (e) { console.log("[Coinstep] Positions parse error:", e.message); }
      }

      // accounts 응답 캡처
      if (url.includes("/agent/accounts") && url.includes("contractType=")) {
        try {
          const cloned = result.clone();
          const data = await cloned.json();
          console.log("[Coinstep] Accounts API intercepted:", url.substring(0, 80), "code:", data?.code, "list:", data?.data?.list?.length);
          if (data?.data?.list) {
            window.postMessage({
              type: "__TAPBIT_ACCOUNTS__",
              data: data.data,
            }, "*");
          }
        } catch (e) { console.log("[Coinstep] Accounts parse error:", e.message); }
      }

      // profile 응답 캡처
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
              },
            }, "*");
          }
        } catch (e) { /* 파싱 에러 무시 */ }
      }

    } catch (e) { /* 감시 에러 무시 — 원본 fetch에 영향 없음 */ }

    return result;
  };

  console.log("[Coinstep] Tapbit fetch monitor active");
})();
