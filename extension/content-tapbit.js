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

  // ── fetch 래핑 코드를 인라인으로 즉시 삽입 (동기 실행, Tapbit JS보다 먼저) ──
  const injectCode = `(function(){
    const _origFetch = window.fetch;
    window.fetch = async function(...args) {
      const result = await _origFetch.apply(this, args);
      try {
        const url = typeof args[0]==="string" ? args[0] : (args[0]?.url||"");
        if (!url.includes("agent-api.tapbit.com")) return result;
        const am = url.match(/auth=([^&]+)/);
        if (am) window.postMessage({type:"__TAPBIT_AUTH__",auth:am[1]},"*");
        if (url.includes("/agent/contract/positions") && url.includes("contractType=")) {
          try { const c=result.clone(); const d=await c.json();
            console.log("[Coinstep] Positions intercepted, list:",d?.data?.list?.length);
            if(d?.data?.list) window.postMessage({type:"__TAPBIT_POSITIONS__",data:d.data},"*");
          } catch(e){ console.log("[Coinstep] Pos parse err:",e.message); }
        }
        if (url.includes("/agent/accounts") && url.includes("contractType=")) {
          try { const c=result.clone(); const d=await c.json();
            console.log("[Coinstep] Accounts intercepted, list:",d?.data?.list?.length);
            if(d?.data?.list) window.postMessage({type:"__TAPBIT_ACCOUNTS__",data:d.data},"*");
          } catch(e){ console.log("[Coinstep] Acc parse err:",e.message); }
        }
        if (url.includes("/agent/profile")) {
          try { const c=result.clone(); const d=await c.json();
            if(d?.data?.maskId) window.postMessage({type:"__TAPBIT_PROFILE__",profile:{maskId:d.data.maskId,remarkName:d.data.remarkName||""}},"*");
          } catch(e){}
        }
      } catch(e){}
      return result;
    };
    console.log("[Coinstep] Tapbit fetch monitor active (inline)");
  })();`;

  const script = document.createElement("script");
  script.textContent = injectCode;
  (document.head || document.documentElement).appendChild(script);
  script.remove();

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

  // ── 로드 완료 알림 (페이지 로드 후) ──
  const notifyLoaded = () => {
    chrome.runtime.sendMessage({ type: "TAB_LOADED", url: window.location.href }).catch(() => {});
    console.log("[Coinstep] Tapbit content script loaded");
  };
  if (document.readyState === "complete" || document.readyState === "interactive") {
    notifyLoaded();
  } else {
    document.addEventListener("DOMContentLoaded", notifyLoaded, { once: true });
  }
})();
