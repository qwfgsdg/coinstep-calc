/**
 * web-sync.js — pro.coinstep.co.kr에서 로드되는 Web-Sync 스크립트
 *
 * content-calc.js의 웹 버전:
 * - 확장 프로그램 없이 Backend API에서 데이터를 가져와 calc.jsx에 전달
 * - PnL 패널 + 수수료 조회 (Backend /api/fee 사용)
 * - calc.jsx와 동일한 CustomEvent 인터페이스 사용 (변경 없음)
 *
 * 모드 감지:
 * - 확장 프로그램이 이미 설치되어 있으면 아무것도 하지 않음 (확장이 처리)
 * - 확장이 없으면 web-sync 모드 활성화
 */
(function () {
  "use strict";

  // ── 설정 ──
  var BACKEND_URL = ""; // 같은 도메인이면 빈 문자열, 다른 서버면 URL 설정
  var POLL_INTERVAL = 5 * 60 * 1000; // 5분
  var STALE_THRESHOLD = 30 * 60 * 1000; // 30분
  var VERY_OLD_THRESHOLD = 2 * 60 * 60 * 1000; // 2시간

  // ── 상태 ──
  var extensionDetected = false;
  var webSyncActive = false;
  var jwtToken = null;
  var pollTimer = null;
  var currentAbortController = null;
  var backoffDelay = 0; // exponential backoff (0 = no backoff)
  var MAX_BACKOFF = 30000; // 최대 30초
  var lastSyncTime = null; // 마지막 동기화 시간 (Freshness 표시용)

  // ── 확장 감지 (2초 대기) ──
  window.addEventListener("tapbit-extension-ready", function () {
    extensionDetected = true;
    console.log("[WebSync] Extension detected — web-sync disabled");
  });

  setTimeout(function () {
    if (!extensionDetected) {
      console.log("[WebSync] No extension detected — activating web-sync mode");
      activateWebSync();
    }
  }, 2000);

  // ── Web-Sync 활성화 ──
  function activateWebSync() {
    webSyncActive = true;

    // JWT 토큰 확인
    jwtToken = localStorage.getItem("coinstep_jwt");
    if (!jwtToken) {
      showLoginPrompt();
      return;
    }

    // 확장 준비 이벤트 발행 (calc.jsx 호환)
    window.dispatchEvent(new CustomEvent("tapbit-extension-ready"));

    // 메시지 수신 (calc.jsx에서 오는 요청 처리)
    window.addEventListener("message", handleCalcMessage);

    // 초기 데이터 로드
    fetchAndDispatch();

    // 폴링 시작 (탭 visible일 때만)
    startPolling();
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stopPolling();
      } else {
        fetchAndDispatch(); // 탭 복귀 시 즉시 fetch
        startPolling();
      }
    });

    // PnL 패널 로드 (histories 포함)
    loadHistoriesAndRenderPanel();

    // 동기화 시간 표시 자동 업데이트 (1분마다)
    setInterval(function () {
      var el = document.getElementById("cs-p-sync-age");
      if (el && lastSyncTime) el.textContent = formatSyncAge(lastSyncTime);
    }, 60000);
  }

  // ── 로그인 프롬프트 ──
  function showLoginPrompt() {
    var overlay = document.createElement("div");
    overlay.id = "ws-login-overlay";
    overlay.style.cssText =
      "position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;" +
      "background:rgba(0,0,0,0.7);display:flex;justify-content:center;align-items:center;";

    overlay.innerHTML =
      '<div style="background:#1a1a2e;padding:32px;border-radius:12px;max-width:380px;width:90%;color:#e2e8f0;font-family:-apple-system,sans-serif;">' +
        '<h3 style="margin:0 0 16px;font-size:18px;color:#f1f5f9;">Coinstep 로그인</h3>' +
        '<p style="margin:0 0 16px;font-size:13px;color:#94a3b8;">관리자에게 발급받은 계정으로 로그인하세요.</p>' +
        '<input id="ws-email" type="email" placeholder="이메일" style="width:100%;padding:10px;margin-bottom:10px;background:#131525;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:14px;outline:none;">' +
        '<input id="ws-password" type="password" placeholder="비밀번호" style="width:100%;padding:10px;margin-bottom:16px;background:#131525;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:14px;outline:none;">' +
        '<button id="ws-login-btn" style="width:100%;padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">로그인</button>' +
        '<p id="ws-login-error" style="margin:8px 0 0;font-size:12px;color:#f87171;display:none;"></p>' +
      '</div>';

    document.body.appendChild(overlay);

    document.getElementById("ws-login-btn").addEventListener("click", function () {
      var email = document.getElementById("ws-email").value;
      var password = document.getElementById("ws-password").value;
      var errorEl = document.getElementById("ws-login-error");

      if (!email || !password) {
        errorEl.textContent = "이메일과 비밀번호를 입력하세요";
        errorEl.style.display = "block";
        return;
      }

      this.disabled = true;
      this.textContent = "로그인 중...";

      fetch(BACKEND_URL + "/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, password: password }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (resp) {
          if (!resp.ok) {
            throw new Error(resp.data.message || "로그인 실패");
          }
          jwtToken = resp.data.token;
          localStorage.setItem("coinstep_jwt", jwtToken);
          overlay.remove();
          activateWebSync();
        })
        .catch(function (err) {
          errorEl.textContent = err.message;
          errorEl.style.display = "block";
          document.getElementById("ws-login-btn").disabled = false;
          document.getElementById("ws-login-btn").textContent = "로그인";
        });
    });
  }

  // ── calc.jsx 메시지 처리 ──
  function handleCalcMessage(e) {
    if (e.source !== window || !webSyncActive) return;

    if (e.data && e.data.type === "CALC_SYNC_REQUEST") {
      fetchAndDispatch();
    }
    if (e.data && e.data.type === "CALC_READ_DATA") {
      fetchAndDispatch();
    }
    if (e.data && e.data.type === "CALC_CHECK_STATUS") {
      window.dispatchEvent(new CustomEvent("tapbit-status-response", {
        detail: { connected: true, mode: "web-sync" },
      }));
    }
  }

  // ── Backend에서 데이터 가져와서 calc.jsx에 전달 ──
  function fetchAndDispatch() {
    if (currentAbortController) {
      currentAbortController.abort();
    }
    currentAbortController = new AbortController();

    fetch(BACKEND_URL + "/api/data", {
      headers: { "Authorization": "Bearer " + jwtToken },
      signal: currentAbortController.signal,
    })
      .then(function (r) {
        if (r.status === 401) {
          localStorage.removeItem("coinstep_jwt");
          jwtToken = null;
          showLoginPrompt();
          throw new Error("TOKEN_EXPIRED");
        }
        // 429 Rate Limited — Retry-After 헤더 존중
        if (r.status === 429) {
          var retryAfter = parseInt(r.headers.get("Retry-After") || "60", 10);
          console.log("[WebSync] Rate limited, retry after " + retryAfter + "s");
          backoffDelay = Math.min(retryAfter * 1000, MAX_BACKOFF);
          throw new Error("RATE_LIMITED");
        }
        return r.json();
      })
      .then(function (data) {
        currentAbortController = null;
        backoffDelay = 0; // 성공 시 backoff 리셋

        // 마지막 동기화 시간 저장
        lastSyncTime = data.meta ? data.meta.lastSyncedAt : null;

        // calc.jsx에 동일한 이벤트 형식으로 전달
        window.dispatchEvent(new CustomEvent("tapbit-sync-response", {
          detail: {
            success: true,
            positions: data.positions || [],
            accounts: data.accounts || [],
            profile: data.profile || null,
            lastSync: lastSyncTime,
            version: Date.now(),
          },
        }));

        // Freshness 배너 업데이트
        updateFreshnessBanner(lastSyncTime);
      })
      .catch(function (err) {
        currentAbortController = null;
        if (err.message === "TOKEN_EXPIRED") return;
        if (err.name === "AbortError") return;

        // Exponential backoff on network errors
        if (err.message !== "RATE_LIMITED") {
          backoffDelay = backoffDelay === 0 ? 1000 : Math.min(backoffDelay * 2, MAX_BACKOFF);
          console.error("[WebSync] Fetch error (backoff " + backoffDelay + "ms):", err.message);
        }
      });
  }

  // ── 폴링 (backoff 반영) ──
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (!document.hidden) {
        var delay = backoffDelay > 0 ? backoffDelay : 0;
        if (delay > 0) {
          console.log("[WebSync] Polling delayed by backoff: " + delay + "ms");
          setTimeout(fetchAndDispatch, delay);
        } else {
          fetchAndDispatch();
        }
      }
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ── Freshness 배너 ──
  function updateFreshnessBanner(lastSyncedAt) {
    var existing = document.getElementById("ws-freshness-banner");
    if (existing) existing.remove();

    if (!lastSyncedAt) {
      showBanner("데이터 없음 — 북마클릿으로 Tapbit에서 동기화하세요", "#f87171");
      return;
    }

    var age = Date.now() - new Date(lastSyncedAt).getTime();
    if (age > VERY_OLD_THRESHOLD) {
      var hours = Math.floor(age / (60 * 60 * 1000));
      showBanner("재동기화 필요 — " + hours + "시간 전 동기화", "#f87171");
    } else if (age > STALE_THRESHOLD) {
      var mins = Math.floor(age / (60 * 1000));
      showBanner(mins + "분 전 동기화 — 최신 데이터를 보려면 북마클릿을 실행하세요", "#faad14");
    }
    // FRESH: no banner
  }

  function showBanner(text, color) {
    var banner = document.createElement("div");
    banner.id = "ws-freshness-banner";
    banner.style.cssText =
      "position:fixed;bottom:0;left:0;right:0;z-index:99997;" +
      "padding:6px 16px;text-align:center;font-size:12px;" +
      "background:" + color + ";color:#fff;" +
      "font-family:-apple-system,sans-serif;";
    banner.textContent = text;
    document.body.appendChild(banner);
  }

  // ═══════════════════════════════════════════════
  // PnL 패널 (content-calc.js 이식 — Backend API 기반)
  // ═══════════════════════════════════════════════

  var currentPnlMode = "margin";
  var allHistories = [];
  var savedStartDate = null;
  var savedEndDate = null;
  var currentTablePage = 1;
  var TABLE_PAGE_SIZE = 100;

  // ── Phase 4: 날짜 보존 (sessionStorage + URL params) ──
  function getSavedDates() {
    // 1순위: URL 파라미터
    var params = new URLSearchParams(window.location.search);
    var urlStart = params.get("startDate");
    var urlEnd = params.get("endDate");
    if (urlStart && urlEnd) {
      return { start: urlStart, end: urlEnd };
    }
    // 2순위: sessionStorage
    var ssStart = sessionStorage.getItem("cs_startDate");
    var ssEnd = sessionStorage.getItem("cs_endDate");
    if (ssStart && ssEnd) {
      return { start: ssStart, end: ssEnd };
    }
    // 기본값: 오늘
    var today = new Date();
    var todayStr = today.getFullYear() + "-" +
      String(today.getMonth() + 1).padStart(2, "0") + "-" +
      String(today.getDate()).padStart(2, "0");
    return { start: todayStr, end: todayStr };
  }

  function saveDates(startDate, endDate) {
    savedStartDate = startDate;
    savedEndDate = endDate;
    sessionStorage.setItem("cs_startDate", startDate);
    sessionStorage.setItem("cs_endDate", endDate);
    // URL에도 반영 (새로고침 시 복원, 공유 가능)
    var url = new URL(window.location);
    url.searchParams.set("startDate", startDate);
    url.searchParams.set("endDate", endDate);
    history.replaceState(null, "", url.toString());
  }

  // ── Phase 4: 마지막 동기화 시간 표시 ──
  function formatSyncAge(lastSyncedAt) {
    if (!lastSyncedAt) return "동기화 없음";
    var age = Date.now() - new Date(lastSyncedAt).getTime();
    if (age < 60000) return "방금 전";
    if (age < 3600000) return Math.floor(age / 60000) + "분 전";
    if (age < 86400000) return Math.floor(age / 3600000) + "시간 전";
    return Math.floor(age / 86400000) + "일 전";
  }

  function loadHistoriesAndRenderPanel() {
    var dates = getSavedDates();
    savedStartDate = dates.start;
    savedEndDate = dates.end;

    var startDate = dates.start + "T00:00:00.000Z";
    var endDate = dates.end + "T23:59:59.999Z";

    fetch(BACKEND_URL + "/api/data?startDate=" + encodeURIComponent(startDate) + "&endDate=" + encodeURIComponent(endDate), {
      headers: { "Authorization": "Bearer " + jwtToken },
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        lastSyncTime = data.meta ? data.meta.lastSyncedAt : null;
        var tryRender = function () {
          if (document.body) {
            renderPnlPanel(data.histories || []);
          } else {
            setTimeout(tryRender, 500);
          }
        };
        setTimeout(tryRender, 1000);
      })
      .catch(function (err) {
        console.error("[WebSync] Histories load error:", err);
      });
  }

  // ── XSS 방어 ──
  function esc(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function calcPnl(tradeData, mode) {
    var profit = parseFloat(tradeData.profit) || 0;
    var tradeFee = parseFloat(tradeData.tradeFee) || 0;
    var tradeAmount = parseFloat(tradeData.tradeAmount) || 0;
    var leverage = tradeData.leverage || 0;
    if (tradeAmount === 0 || (mode === "margin" && leverage === 0))
      return { pure: null, withFee: null };
    var base = mode === "margin" ? tradeAmount / leverage : tradeAmount;
    return { pure: (profit / base) * 100, withFee: ((profit - tradeFee) / base) * 100 };
  }

  function formatPnl(v) {
    if (v === null || v === undefined || isNaN(v)) return "\u2014";
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }
  function formatUsdt(v) {
    var n = parseFloat(v) || 0;
    return (n >= 0 ? "+" : "") + n.toFixed(4);
  }
  function formatTime(ts) {
    if (!ts) return "\u2014";
    var d = new Date(ts);
    return d.toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" })
      + " " + d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  }
  function formatSide(v) {
    if (!v && v !== 0) return { label: "\u2014", color: "#6b7280" };
    var s = String(v).toUpperCase();
    if (s === "1" || s === "BUY" || s === "LONG" || s === "OPEN_LONG")
      return { label: "Long", color: "#34d399" };
    if (s === "2" || s === "SELL" || s === "SHORT" || s === "OPEN_SHORT")
      return { label: "Short", color: "#f87171" };
    if (s === "3" || s === "CLOSE_LONG")
      return { label: "Close Long", color: "#34d399" };
    if (s === "4" || s === "CLOSE_SHORT")
      return { label: "Close Short", color: "#f87171" };
    return { label: v, color: "#94a3b8" };
  }
  function getPnlColor(v) {
    if (v === null || v === undefined || isNaN(v)) return "#6b7280";
    return v >= 0 ? "#34d399" : "#f87171";
  }

  function renderPnlPanel(histories) {
    allHistories = histories;
    var panel = document.getElementById("cs-pnl-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "cs-pnl-panel";
      document.body.appendChild(panel);
    }

    var memberMap = new Map();
    histories.forEach(function (item) {
      if (item.maskId && !memberMap.has(item.maskId)) {
        memberMap.set(item.maskId, item.remarkName || "회원 " + item.maskId);
      }
    });

    var totalFee = 0;
    histories.forEach(function (item) {
      totalFee += parseFloat(item.data ? item.data.tradeFee : item.tradeFee) || 0;
    });

    var memberOptions = Array.from(memberMap.entries())
      .map(function (e) { return '<option value="' + esc(e[0]) + '">' + esc(e[1]) + '</option>'; })
      .join("");

    // content-calc.js와 동일한 UI (CSS + HTML)
    panel.innerHTML =
      '<style>' +
        '#cs-pnl-panel{position:fixed;top:0;left:0;right:0;z-index:99998;background:#0a0a14;border-bottom:2px solid #1e293b;font-family:-apple-system,"Segoe UI",sans-serif;color:#e2e8f0;max-height:50vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,0.5);}' +
        '#cs-pnl-panel *{box-sizing:border-box;}' +
        '.cs-p-header{display:flex;justify-content:space-between;align-items:center;padding:8px 16px;background:#0f1120;border-bottom:1px solid #1e293b;flex-shrink:0;cursor:pointer;}' +
        '.cs-p-header:hover{background:#151530 !important;}' +
        '.cs-p-title{font-weight:700;font-size:13px;color:#f1f5f9;}' +
        '.cs-p-controls{display:flex;gap:8px;align-items:center;}' +
        '.cs-p-btn{background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;transition:background 0.15s;}' +
        '.cs-p-btn:hover{background:#334155;color:#e2e8f0;}' +
        '.cs-p-btn.active{background:#3b82f6;color:#fff;border-color:#3b82f6;}' +
        '.cs-p-close{background:none;border:none;color:#64748b;cursor:pointer;font-size:16px;padding:0 4px;line-height:1;}' +
        '.cs-p-close:hover{color:#f87171;}' +
        '.cs-p-toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:8px 16px;background:#0d0d1a;border-bottom:1px solid #1a1a2e;flex-shrink:0;}' +
        '.cs-p-toolbar label{color:#64748b;font-size:11px;white-space:nowrap;}' +
        '.cs-p-toolbar select,.cs-p-toolbar input[type="date"]{background:#131525;border:1px solid #1e293b;border-radius:4px;color:#e2e8f0;padding:3px 8px;font-size:11px;outline:none;}' +
        '.cs-p-toolbar input[type="date"]::-webkit-calendar-picker-indicator{filter:invert(0.7);}' +
        '.cs-p-search-btn{background:#3b82f6;color:#fff;border:none;border-radius:4px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;}' +
        '.cs-p-search-btn:hover{background:#2563eb;}' +
        '.cs-p-search-btn:disabled{opacity:0.5;cursor:wait;}' +
        '.cs-p-summary{display:flex;gap:16px;margin-left:auto;align-items:center;}' +
        '.cs-p-stat{text-align:right;}' +
        '.cs-p-stat-label{font-size:10px;color:#475569;}' +
        '.cs-p-stat-value{font-size:13px;font-weight:700;color:#34d399;font-family:monospace;}' +
        '.cs-p-table-wrap{overflow-y:auto;flex:1;}' +
        '.cs-p-table{width:100%;border-collapse:collapse;font-size:11px;}' +
        '.cs-p-table thead{position:sticky;top:0;z-index:1;}' +
        '.cs-p-table th{background:#111125;color:#64748b;font-weight:600;padding:6px 12px;text-align:right;border-bottom:1px solid #1e293b;white-space:nowrap;}' +
        '.cs-p-table th:first-child,.cs-p-table td:first-child{text-align:left;}' +
        '.cs-p-table td{padding:5px 12px;border-bottom:1px solid #0f0f20;text-align:right;font-family:monospace;white-space:nowrap;}' +
        '.cs-p-table tbody tr:hover{background:#131530;}' +
        '.cs-p-empty{text-align:center;padding:24px;color:#475569;font-size:12px;}' +
        '.cs-p-collapsed .cs-p-toolbar,.cs-p-collapsed .cs-p-table-wrap,.cs-p-collapsed .cs-p-mode-btns,.cs-p-collapsed .cs-p-pagination{display:none;}' +
        '.cs-p-collapsed{max-height:36px;}' +
        '.cs-p-toggle-icon{font-size:12px;color:#64748b;margin-left:8px;transition:transform 0.2s;}' +
        '.cs-p-count{font-size:11px;color:#3b82f6;margin-left:8px;font-weight:400;}' +
        '.cs-p-pagination{display:flex;justify-content:center;align-items:center;gap:8px;padding:6px 16px;background:#0d0d1a;border-top:1px solid #1a1a2e;flex-shrink:0;}' +
        '.cs-p-page-btn{background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;min-width:28px;text-align:center;}' +
        '.cs-p-page-btn:hover{background:#334155;color:#e2e8f0;}' +
        '.cs-p-page-btn:disabled{opacity:0.3;cursor:default;}' +
        '.cs-p-page-info{font-size:11px;color:#64748b;}' +
      '</style>' +

      '<div class="cs-p-header" id="cs-p-header-toggle">' +
        '<span class="cs-p-title">거래내역 PnL% · 수수료 분석 <span style="color:#3b82f6;font-size:10px;font-weight:400;">[Web-Sync]</span>' +
          '<span class="cs-p-count">' + histories.length + '건</span>' +
          '<span id="cs-p-sync-age" style="font-size:10px;color:#64748b;margin-left:8px;font-weight:400;">' + formatSyncAge(lastSyncTime) + '</span>' +
          '<span class="cs-p-toggle-icon">▼</span></span>' +
        '<div class="cs-p-controls">' +
          '<span class="cs-p-mode-btns">' +
            '<button class="cs-p-btn ' + (currentPnlMode === "margin" ? "active" : "") + '" id="cs-mode-margin">마진 기준</button>' +
            '<button class="cs-p-btn ' + (currentPnlMode === "amount" ? "active" : "") + '" id="cs-mode-amount">거래금액 기준</button>' +
          '</span>' +
          '<button class="cs-p-close" id="cs-p-close">✕</button>' +
        '</div>' +
      '</div>' +

      '<div class="cs-p-toolbar">' +
        '<label>회원:</label>' +
        '<select id="cs-p-member"><option value="">전체</option>' + memberOptions + '</select>' +
        '<label>시작일:</label><input type="date" id="cs-p-start">' +
        '<label>종료일:</label><input type="date" id="cs-p-end">' +
        '<button class="cs-p-search-btn" id="cs-p-search">수수료 조회</button>' +
        '<div class="cs-p-summary">' +
          '<div class="cs-p-stat"><div class="cs-p-stat-label">총 수수료 (현재 목록)</div>' +
            '<div class="cs-p-stat-value" id="cs-p-fee-local">' + totalFee.toFixed(6) + ' USDT</div></div>' +
          '<div class="cs-p-stat"><div class="cs-p-stat-label">조회 수수료</div>' +
            '<div class="cs-p-stat-value" id="cs-p-fee-api">\u2014 USDT</div></div>' +
          '<div class="cs-p-stat"><div class="cs-p-stat-label">거래 회원</div>' +
            '<div class="cs-p-stat-value" id="cs-p-traders">' + memberMap.size + '명</div></div>' +
        '</div>' +
      '</div>' +

      '<div class="cs-p-table-wrap"><table class="cs-p-table"><thead><tr>' +
        '<th>회원</th><th>거래쌍</th><th>방향</th><th>레버리지</th><th>거래금액</th><th>손익</th><th>수수료</th><th>PnL%(수수료 미반영)</th><th>PnL%(수수료 반영)</th><th>시간</th>' +
      '</tr></thead><tbody id="cs-p-tbody"></tbody></table></div>' +
      '<div class="cs-p-pagination" id="cs-p-pagination"></div>';

    currentTablePage = 1;
    renderTablePage();

    // 날짜 복원 (sessionStorage/URL에서)
    var dates = getSavedDates();
    document.getElementById("cs-p-start").value = dates.start;
    document.getElementById("cs-p-end").value = dates.end;

    var savedState = localStorage.getItem("cs-pnl-panel-state");
    if (savedState === "expanded") {
      panel.classList.add("cs-p-expanded");
    } else {
      panel.classList.add("cs-p-collapsed");
    }

    bindPanelEvents();
  }

  function renderTableRows(histories) {
    var tbody = document.getElementById("cs-p-tbody");
    if (!tbody) return;
    if (!histories || histories.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="cs-p-empty">거래내역이 없습니다. 북마클릿으로 Tapbit에서 동기화하세요.</td></tr>';
      return;
    }
    tbody.innerHTML = histories.map(function (item) {
      var d = item.data || item;
      var pnl = calcPnl(d, currentPnlMode);
      var profit = parseFloat(d.profit) || 0;
      var fee = parseFloat(d.tradeFee) || 0;
      var side = formatSide(d.side || d.positionSide || d.direction);
      return '<tr>' +
        '<td style="color:#94a3b8;text-align:left;max-width:120px;overflow:hidden;text-overflow:ellipsis;">' + esc(item.remarkName || item.maskId || "\u2014") + '</td>' +
        '<td style="color:#e2e8f0;">' + esc(d.contractName || "\u2014") + '</td>' +
        '<td style="color:' + side.color + ';font-weight:600;">' + esc(side.label) + '</td>' +
        '<td>' + (d.leverage || "\u2014") + 'x</td>' +
        '<td>' + formatUsdt(d.tradeAmount) + '</td>' +
        '<td style="color:' + (profit >= 0 ? "#34d399" : "#f87171") + '">' + formatUsdt(d.profit) + '</td>' +
        '<td style="color:#f59e0b">' + fee.toFixed(4) + '</td>' +
        '<td style="color:' + getPnlColor(pnl.pure) + ';font-weight:700;">' + formatPnl(pnl.pure) + '</td>' +
        '<td style="color:' + getPnlColor(pnl.withFee) + ';font-weight:700;">' + formatPnl(pnl.withFee) + '</td>' +
        '<td style="color:#64748b;font-size:10px;">' + formatTime(d.createTime) + '</td>' +
      '</tr>';
    }).join("");
  }

  function getFilteredHistories() {
    var el = document.getElementById("cs-p-member");
    var m = el ? el.value : "";
    return m ? allHistories.filter(function (h) { return String(h.maskId) === m; }) : allHistories;
  }

  function renderTablePage() {
    var filtered = getFilteredHistories();
    var totalPages = Math.max(1, Math.ceil(filtered.length / TABLE_PAGE_SIZE));
    if (currentTablePage > totalPages) currentTablePage = totalPages;
    var start = (currentTablePage - 1) * TABLE_PAGE_SIZE;
    renderTableRows(filtered.slice(start, start + TABLE_PAGE_SIZE));
    renderPagination(filtered.length, totalPages);
  }

  function renderPagination(totalItems, totalPages) {
    var el = document.getElementById("cs-p-pagination");
    if (!el) return;
    if (totalItems <= TABLE_PAGE_SIZE) { el.innerHTML = ""; return; }
    el.innerHTML =
      '<button class="cs-p-page-btn" id="cs-p-prev" ' + (currentTablePage <= 1 ? "disabled" : "") + '>&lt;</button>' +
      '<span class="cs-p-page-info">' + currentTablePage + ' / ' + totalPages + ' (' + totalItems + '건)</span>' +
      '<button class="cs-p-page-btn" id="cs-p-next" ' + (currentTablePage >= totalPages ? "disabled" : "") + '>&gt;</button>';

    var prev = document.getElementById("cs-p-prev");
    var next = document.getElementById("cs-p-next");
    if (prev) prev.addEventListener("click", function () { if (currentTablePage > 1) { currentTablePage--; renderTablePage(); } });
    if (next) next.addEventListener("click", function () { if (currentTablePage < totalPages) { currentTablePage++; renderTablePage(); } });
  }

  function bindPanelEvents() {
    document.getElementById("cs-p-header-toggle").addEventListener("click", function (e) {
      if (e.target.closest(".cs-p-close") || e.target.closest(".cs-p-btn")) return;
      var panel = document.getElementById("cs-pnl-panel");
      var isCollapsed = panel.classList.contains("cs-p-collapsed");
      panel.classList.toggle("cs-p-collapsed");
      panel.classList.toggle("cs-p-expanded");
      var icon = panel.querySelector(".cs-p-toggle-icon");
      if (icon) icon.textContent = isCollapsed ? "\u25B2" : "\u25BC";
      localStorage.setItem("cs-pnl-panel-state", isCollapsed ? "expanded" : "collapsed");
    });

    document.getElementById("cs-mode-margin").addEventListener("click", function (e) {
      e.stopPropagation();
      currentPnlMode = "margin";
      this.classList.add("active");
      document.getElementById("cs-mode-amount").classList.remove("active");
      renderTablePage();
    });
    document.getElementById("cs-mode-amount").addEventListener("click", function (e) {
      e.stopPropagation();
      currentPnlMode = "amount";
      this.classList.add("active");
      document.getElementById("cs-mode-margin").classList.remove("active");
      renderTablePage();
    });

    document.getElementById("cs-p-close").addEventListener("click", function (e) {
      e.stopPropagation();
      document.getElementById("cs-pnl-panel").style.display = "none";
    });

    document.getElementById("cs-p-member").addEventListener("change", function () {
      currentTablePage = 1;
      renderTablePage();
      updateLocalFeeSum();
    });

    // 수수료 조회 — Backend API 사용 (확장의 chrome.runtime.sendMessage 대체)
    document.getElementById("cs-p-search").addEventListener("click", fetchFeeSummary);
  }

  function updateLocalFeeSum() {
    var feeEl = document.getElementById("cs-p-fee-local");
    if (!feeEl) return;
    var memberEl = document.getElementById("cs-p-member");
    var m = memberEl ? memberEl.value : "";
    var list = m ? allHistories.filter(function (h) { return String(h.maskId) === m; }) : allHistories;
    var total = 0;
    list.forEach(function (i) { total += parseFloat(i.data ? i.data.tradeFee : i.tradeFee) || 0; });
    feeEl.textContent = total.toFixed(6) + " USDT";
  }

  // ── 수수료 조회 (Backend /api/fee) ──
  function fetchFeeSummary() {
    var startInput = document.getElementById("cs-p-start");
    var endInput = document.getElementById("cs-p-end");
    var searchBtn = document.getElementById("cs-p-search");
    var feeEl = document.getElementById("cs-p-fee-api");
    var tradersEl = document.getElementById("cs-p-traders");

    if (!startInput.value || !endInput.value) {
      feeEl.textContent = "날짜를 선택하세요";
      feeEl.style.color = "#f87171";
      return;
    }

    // 날짜 보존 (sessionStorage + URL)
    saveDates(startInput.value, endInput.value);

    var startDate = startInput.value + "T00:00:00.000Z";
    var endDate = endInput.value + "T23:59:59.999Z";

    feeEl.textContent = "조회 중...";
    feeEl.style.color = "#64748b";
    searchBtn.disabled = true;

    // Backend API로 수수료 조회 (Tapbit API 호출 없음)
    fetch(BACKEND_URL + "/api/fee", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + jwtToken,
      },
      body: JSON.stringify({ startDate: startDate, endDate: endDate }),
    })
      .then(function (r) {
        if (r.status === 401) {
          localStorage.removeItem("coinstep_jwt");
          jwtToken = null;
          throw new Error("TOKEN_EXPIRED");
        }
        return r.json();
      })
      .then(function (data) {
        searchBtn.disabled = false;
        var fee = parseFloat(data.totalFee) || 0;
        feeEl.textContent = fee.toFixed(6) + " USDT (" + (data.recordCount || 0) + "건)";
        feeEl.style.color = "#34d399";
        tradersEl.textContent = (data.traders ? data.traders.length : 0) + "명";

        // 해당 기간 거래내역도 가져와서 테이블 업데이트
        return fetch(BACKEND_URL + "/api/data?startDate=" + encodeURIComponent(startDate) + "&endDate=" + encodeURIComponent(endDate), {
          headers: { "Authorization": "Bearer " + jwtToken },
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.histories && data.histories.length > 0) {
          allHistories = data.histories;
          currentTablePage = 1;
          var countEl = document.querySelector(".cs-p-count");
          if (countEl) countEl.textContent = allHistories.length + "건";

          // 회원 목록 업데이트
          var memberEl = document.getElementById("cs-p-member");
          var currentMember = memberEl ? memberEl.value : "";
          var memberMap = new Map();
          allHistories.forEach(function (i) {
            if (i.maskId && !memberMap.has(i.maskId)) memberMap.set(i.maskId, i.remarkName || "회원 " + i.maskId);
          });
          if (memberEl) {
            memberEl.innerHTML = '<option value="">전체</option>' +
              Array.from(memberMap.entries()).map(function (e) {
                return '<option value="' + esc(e[0]) + '">' + esc(e[1]) + '</option>';
              }).join("");
            memberEl.value = currentMember;
          }
          renderTablePage();
          updateLocalFeeSum();
        }
      })
      .catch(function (err) {
        searchBtn.disabled = false;
        if (err.message === "TOKEN_EXPIRED") {
          showLoginPrompt();
          return;
        }
        feeEl.textContent = "조회 실패";
        feeEl.style.color = "#f87171";
        console.error("[WebSync] Fee query error:", err);
      });
  }

  console.log("[WebSync] Web-sync script loaded");
})();
