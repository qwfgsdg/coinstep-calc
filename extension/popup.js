/**
 * popup.js — 확장 팝업 UI 로직
 */

(function() {
  "use strict";

  const dot = document.getElementById("dot");
  const tapbitStatus = document.getElementById("tapbit-status");
  const agentName = document.getElementById("agent-name");
  const authStatus = document.getElementById("auth-status");
  const hint = document.getElementById("hint");
  const syncBtn = document.getElementById("sync-btn");

  function updateUI(status) {
    if (status.connected) {
      dot.classList.remove("off");
      tapbitStatus.textContent = "연결됨";
      tapbitStatus.classList.add("connected");
      tapbitStatus.classList.remove("disconnected");
      authStatus.textContent = "✓ 캡처됨";
      authStatus.classList.add("connected");
      syncBtn.disabled = false;
      syncBtn.textContent = "📥 계산기에서 불러오기 사용 가능";
      hint.textContent = "calc.coinstep.co.kr에서 '📥 Tapbit에서 불러오기' 버튼을 클릭하세요.";
    } else {
      dot.classList.add("off");
      tapbitStatus.textContent = "미연결";
      tapbitStatus.classList.remove("connected");
      tapbitStatus.classList.add("disconnected");
      authStatus.textContent = "—";
      authStatus.classList.remove("connected");
      syncBtn.disabled = true;
      syncBtn.textContent = "Tapbit 관리자 페이지를 열어주세요";
      hint.textContent = "Tapbit 관리자 페이지(agent.tapbit.com)에 로그인하면 자동으로 연결됩니다.";
    }

    if (status.profile?.remarkName) {
      agentName.textContent = status.profile.remarkName;
    } else {
      agentName.textContent = "—";
    }
  }

  // 상태 확인
  chrome.runtime.sendMessage({ type: "CHECK_STATUS" }, (response) => {
    if (chrome.runtime.lastError) {
      updateUI({ connected: false });
      return;
    }
    updateUI(response || { connected: false });
  });

  // 계산기 열기 버튼
  syncBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://calc.coinstep.co.kr" });
    window.close();
  });
})();
