/**
 * content-tapbit.js — agent.tapbit.com에 주입되는 content script
 * 
 * 역할:
 * 1. inject-tapbit.js를 페이지 컨텍스트에 삽입
 * 2. auth 토큰을 background.js로 전달
 * 3. background.js의 데이터 요청을 페이지 컨텍스트에서 실행
 */

(function() {
  "use strict";

  let lastAuth = null;
  let lastProfile = null;

  // ── inject-tapbit.js를 페이지 컨텍스트에 삽입 ──
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject-tapbit.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // ── 페이지에서 보내는 메시지 수신 ──
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;

    // auth 토큰 캡처
    if (e.data?.type === "__TAPBIT_AUTH__" && e.data.auth) {
      lastAuth = e.data.auth;
      chrome.runtime.sendMessage({
        type: "AUTH_CAPTURED",
        auth: lastAuth,
      }).catch(() => {}); // 확장이 reload 중이면 에러 무시
    }

    // 프로필 정보 캡처
    if (e.data?.type === "__TAPBIT_PROFILE__" && e.data.profile) {
      lastProfile = e.data.profile;
      chrome.runtime.sendMessage({
        type: "PROFILE_CAPTURED",
        profile: lastProfile,
      }).catch(() => {});
    }
  });

  // ── background.js에서 데이터 요청 수신 ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "FETCH_DATA") {
      fetchTapbitData()
        .then(sendResponse)
        .catch(err => sendResponse({ error: "FETCH_FAILED", message: err.message }));
      return true; // 비동기 응답 대기
    }
  });

  // ── Tapbit 내부 API 호출 (페이지의 세션 쿠키 활용) ──
  async function fetchTapbitData() {
    if (!lastAuth) {
      // auth가 아직 캡처 안 됨 → 페이지 리소스에서 추출 시도
      // 또는 에러 반환
      return { error: "NO_AUTH", message: "Tapbit 관리자 페이지를 새로고침해주세요" };
    }

    try {
      const baseUrl = "https://agent-api.tapbit.com";

      // positions + accounts 병렬 호출
      const [posRes, accRes] = await Promise.all([
        fetch(`${baseUrl}/agent/contract/positions?contractType=USDT_MARGIN_CONTRACT&pageNumber=1&pageSize=50&auth=${lastAuth}`, {
          credentials: "include",
          headers: {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json; charset=utf-8",
          },
        }),
        fetch(`${baseUrl}/agent/accounts?contractType=USDT_MARGIN_CONTRACT&userType=&pageNumber=1&pageSize=50&auth=${lastAuth}`, {
          credentials: "include",
          headers: {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json; charset=utf-8",
          },
        }),
      ]);

      // 인증 만료 체크
      if (posRes.status === 401 || posRes.status === 403) {
        lastAuth = null;
        return { error: "AUTH_EXPIRED", message: "Tapbit 로그인이 만료되었습니다. 다시 로그인해주세요" };
      }

      const [posData, accData] = await Promise.all([
        posRes.json(),
        accRes.json(),
      ]);

      // API 에러 체크
      if (posData.code !== 200) {
        return { error: "API_ERROR", message: posData.message || "positions API 오류" };
      }

      return {
        success: true,
        positions: posData.data?.list || [],
        accounts: accData.data?.list || [],
        profile: lastProfile,
      };

    } catch (e) {
      return { error: "NETWORK", message: e.message };
    }
  }

  console.log("[Coinstep] Tapbit content script loaded");
})();
