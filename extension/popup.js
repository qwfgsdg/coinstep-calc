/**
 * popup.js — 확장 팝업 UI 로직
 */

(function() {
  "use strict";

  const dot = document.getElementById("dot");
  const syncBtn = document.getElementById("sync-btn");
  const autoToggle = document.getElementById("auto-toggle");
  const progress = document.getElementById("progress");
  const stState = document.getElementById("st-state");
  const stProfile = document.getElementById("st-profile");
  const stTime = document.getElementById("st-time");
  const stUsers = document.getElementById("st-users");

  let currentState = "IDLE";
  let isAutoRefresh = false;

  // ── UI 업데이트 ──
  function updateUI(status) {
    currentState = status.state || "IDLE";
    isAutoRefresh = status.autoRefreshEnabled || false;

    // 상태 dot
    dot.className = "dot";
    if (currentState === "IDLE") dot.classList.add("idle");
    else if (currentState === "SYNCED") dot.classList.add("synced");
    else if (currentState === "AUTO_REFRESH") dot.classList.add("auto");
    else dot.classList.add("working");

    // 상태 텍스트
    const stateLabels = {
      "IDLE": "대기 중",
      "OPENING_TABS": "탭 열는 중...",
      "WAITING_DATA": "데이터 수집 중...",
      "SYNCED": "동기화 완료",
      "AUTO_REFRESH": "자동 갱신 중",
    };
    stState.textContent = stateLabels[currentState] || currentState;
    stState.className = "status-value";
    if (currentState === "SYNCED" || currentState === "AUTO_REFRESH") stState.classList.add("ok");
    else if (currentState === "IDLE") {}
    else stState.classList.add("warn");

    // 동기화 버튼
    if (currentState === "IDLE") {
      syncBtn.textContent = "🔄 동기화 시작";
      syncBtn.className = "sync-btn";
      syncBtn.disabled = false;
    } else if (currentState === "OPENING_TABS" || currentState === "WAITING_DATA") {
      syncBtn.textContent = "⏳ 동기화 중...";
      syncBtn.className = "sync-btn";
      syncBtn.disabled = true;
    } else {
      syncBtn.textContent = "⏹ 동기화 중지";
      syncBtn.className = "sync-btn stop";
      syncBtn.disabled = false;
    }

    // 자동 갱신 토글
    autoToggle.className = isAutoRefresh ? "toggle on" : "toggle";

    // 프로필
    if (status.profile?.remarkName) {
      stProfile.textContent = status.profile.remarkName;
    } else {
      stProfile.textContent = "—";
    }

    // 마지막 동기화 시간
    if (status.lastSync) {
      const sec = Math.floor((Date.now() - status.lastSync) / 1000);
      if (sec < 60) stTime.textContent = sec + "초 전";
      else if (sec < 3600) stTime.textContent = Math.floor(sec / 60) + "분 전";
      else stTime.textContent = new Date(status.lastSync).toLocaleTimeString("ko-KR");
    } else {
      stTime.textContent = "—";
    }

    // 유저 수
    if (status.userCount > 0) {
      stUsers.textContent = status.userCount + "명";
    } else {
      stUsers.textContent = "—";
    }

    // 진행 표시
    if (currentState === "OPENING_TABS") {
      progress.style.display = "block";
      progress.innerHTML = '<div class="step"><span class="icon">⏳</span> Tapbit 페이지 열는 중...</div>';
    } else if (currentState === "WAITING_DATA") {
      progress.style.display = "block";
      progress.innerHTML = '<div class="step"><span class="icon">📊</span> 포지션 & 잔고 불러오는 중...</div>';
    } else {
      progress.style.display = "none";
    }
  }

  // ── 초기 상태 로딩 ──
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
    if (chrome.runtime.lastError) {
      updateUI({ state: "IDLE" });
      return;
    }
    updateUI(response || { state: "IDLE" });
  });

  // ── 실시간 상태 업데이트 수신 ──
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "STATE_UPDATE") {
      // 상태만 먼저 빠르게 반영하고, 전체 상태는 다시 요청
      chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
        if (!chrome.runtime.lastError && response) updateUI(response);
      });
    }
  });

  // ── 동기화 버튼 ──
  syncBtn.addEventListener("click", () => {
    if (currentState === "IDLE") {
      chrome.runtime.sendMessage({ type: "SYNC_START" });
      updateUI({ state: "OPENING_TABS", autoRefreshEnabled: isAutoRefresh });
    } else {
      chrome.runtime.sendMessage({ type: "SYNC_STOP" });
      updateUI({ state: "IDLE", autoRefreshEnabled: isAutoRefresh });
    }
  });

  // ── 자동 갱신 토글 ──
  autoToggle.addEventListener("click", () => {
    isAutoRefresh = !isAutoRefresh;
    chrome.runtime.sendMessage({ type: "SET_AUTO_REFRESH", enabled: isAutoRefresh });
    autoToggle.className = isAutoRefresh ? "toggle on" : "toggle";
  });

  // ── 주기적 UI 갱신 (시간 표시 업데이트) ──
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
      if (!chrome.runtime.lastError && response) updateUI(response);
    });
  }, 5000);

})();
