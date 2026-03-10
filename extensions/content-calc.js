/**
 * content-calc.js — pro.coinstep.co.kr에 주입되는 content script
 *
 * 역할:
 * 1. 확장 존재 알림
 * 2. chrome.storage 변경 감지 → 계산기에 이벤트 발행
 * 3. 수동 동기화 요청 중계 (하위 호환)
 * 4. PnL% 거래내역 테이블 + 수수료 분석 패널 주입
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

    // histories 변경 시 PnL 패널 업데이트 (fee query 중에는 무시)
    if (area === "local" && changes.tapbitHistories) {
      if (isFeeQuerying) {
        console.log("[Coinstep] Skipping re-render during fee query");
        return;
      }
      const newData = changes.tapbitHistories.newValue;
      if (newData?.list) {
        renderPnlPanel(newData.list);
      }
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

  // 초기 로드 시 histories 데이터도 표시
  chrome.storage.local.get(["tapbitHistories", "tapbitAuth"], (result) => {
    console.log("[Coinstep] Storage check — histories:", result?.tapbitHistories?.list?.length || 0, "items, auth:", result?.tapbitAuth ? "exists" : "none");
    const data = result?.tapbitHistories;
    if (data?.list?.length > 0) {
      console.log("[Coinstep] Rendering PnL panel with", data.list.length, "items");
      // 페이지 로드 완료 대기 후 렌더링
      const tryRender = () => {
        if (document.body) {
          renderPnlPanel(data.list);
        } else {
          setTimeout(tryRender, 500);
        }
      };
      setTimeout(tryRender, 1000);
    } else {
      console.log("[Coinstep] No histories data — visit Tapbit historyOrders page first");
    }
  });

  // ── 수동 동기화 요청 중계 (기존 호환) ──
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;

    if (e.data?.type === "CALC_SYNC_REQUEST") {
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

      chrome.runtime.sendMessage({ type: "SYNC_START" }, (response) => {
        if (chrome.runtime.lastError) {
          window.dispatchEvent(new CustomEvent("tapbit-sync-response", {
            detail: { error: "EXTENSION_ERROR", message: "확장 프로그램 오류" },
          }));
        }
      });
    }

    if (e.data?.type === "CALC_READ_DATA") {
      console.log("[Coinstep] CALC_READ_DATA received");
      chrome.storage.local.get("tapbitData", (result) => {
        const data = result?.tapbitData;
        console.log("[Coinstep] Storage data:", data ? `positions=${data.positions?.length}, accounts=${data.accounts?.length}` : "empty");
        if (data) {
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
        } else {
          window.dispatchEvent(new CustomEvent("tapbit-sync-response", {
            detail: { success: false, error: "NO_DATA", message: "동기화 데이터 없음 — 확장에서 먼저 동기화하세요" },
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

  // ═══════════════════════════════════════════════
  // PnL% 거래내역 + 수수료 분석 패널
  // ═══════════════════════════════════════════════

  let currentPnlMode = "margin"; // "margin" | "amount"
  let allHistories = [];
  let savedStartDate = null; // 사용자 선택 날짜 보존
  let savedEndDate = null;
  let isFeeQuerying = false; // fee query 중 re-render 방지
  let currentTablePage = 1; // 테이블 페이지네이션
  const TABLE_PAGE_SIZE = 100;

  // XSS 방어: HTML 특수문자 이스케이프
  function esc(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function calcPnl(tradeData, mode) {
    const profit = parseFloat(tradeData.profit) || 0;
    const tradeFee = parseFloat(tradeData.tradeFee) || 0;
    const tradeAmount = parseFloat(tradeData.tradeAmount) || 0;
    const leverage = tradeData.leverage || 0;

    if (tradeAmount === 0 || (mode === "margin" && leverage === 0)) {
      return { pure: null, withFee: null };
    }

    const base = mode === "margin" ? (tradeAmount / leverage) : tradeAmount;
    return {
      pure: (profit / base) * 100,
      withFee: ((profit - tradeFee) / base) * 100,
    };
  }

  function formatPnl(value) {
    if (value === null || value === undefined || isNaN(value)) return "—";
    const sign = value >= 0 ? "+" : "";
    return sign + value.toFixed(2) + "%";
  }

  function formatUsdt(value) {
    const num = parseFloat(value) || 0;
    const sign = num >= 0 ? "+" : "";
    return sign + num.toFixed(4);
  }

  function formatTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    return d.toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit" })
      + " " + d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  }

  function formatSide(value) {
    if (!value && value !== 0) return { label: "—", color: "#6b7280" };
    const s = String(value).toUpperCase();
    if (s === "1" || s === "BUY" || s === "LONG" || s === "OPEN_LONG")
      return { label: "Long", color: "#34d399" };
    if (s === "2" || s === "SELL" || s === "SHORT" || s === "OPEN_SHORT")
      return { label: "Short", color: "#f87171" };
    if (s === "3" || s === "CLOSE_LONG")
      return { label: "Close Long", color: "#34d399" };
    if (s === "4" || s === "CLOSE_SHORT")
      return { label: "Close Short", color: "#f87171" };
    return { label: value, color: "#94a3b8" };
  }

  function getPnlColor(value) {
    if (value === null || value === undefined || isNaN(value)) return "#6b7280";
    return value >= 0 ? "#34d399" : "#f87171";
  }

  function renderPnlPanel(histories) {
    allHistories = histories;

    let panel = document.getElementById("cs-pnl-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "cs-pnl-panel";
      document.body.appendChild(panel);
    }

    // 회원 목록 추출 (중복 제거)
    const memberMap = new Map();
    histories.forEach(item => {
      if (item.maskId && !memberMap.has(item.maskId)) {
        memberMap.set(item.maskId, item.remarkName || "회원 " + item.maskId);
      }
    });

    // 수수료 합계 계산
    let totalFee = 0;
    histories.forEach(item => {
      totalFee += parseFloat(item.data?.tradeFee) || 0;
    });

    const memberOptions = Array.from(memberMap.entries())
      .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`)
      .join("");

    panel.innerHTML = `
      <style>
        #cs-pnl-panel {
          position: fixed; top: 0; left: 0; right: 0; z-index: 99998;
          background: #0a0a14; border-bottom: 2px solid #1e293b;
          font-family: -apple-system, 'Segoe UI', sans-serif;
          color: #e2e8f0; max-height: 50vh; overflow: hidden;
          display: flex; flex-direction: column;
          box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        }
        #cs-pnl-panel * { box-sizing: border-box; }

        .cs-p-header {
          display: flex; justify-content: space-between; align-items: center;
          padding: 8px 16px; background: #0f1120; border-bottom: 1px solid #1e293b;
          flex-shrink: 0;
        }
        .cs-p-title { font-weight: 700; font-size: 13px; color: #f1f5f9; }
        .cs-p-controls { display: flex; gap: 8px; align-items: center; }
        .cs-p-btn {
          background: #1e293b; color: #94a3b8; border: 1px solid #334155;
          border-radius: 4px; padding: 3px 10px; font-size: 11px;
          cursor: pointer; transition: background 0.15s;
        }
        .cs-p-btn:hover { background: #334155; color: #e2e8f0; }
        .cs-p-btn.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
        .cs-p-close {
          background: none; border: none; color: #64748b; cursor: pointer;
          font-size: 16px; padding: 0 4px; line-height: 1;
        }
        .cs-p-close:hover { color: #f87171; }

        .cs-p-toolbar {
          display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
          padding: 8px 16px; background: #0d0d1a; border-bottom: 1px solid #1a1a2e;
          flex-shrink: 0;
        }
        .cs-p-toolbar label { color: #64748b; font-size: 11px; white-space: nowrap; }
        .cs-p-toolbar select, .cs-p-toolbar input[type="date"] {
          background: #131525; border: 1px solid #1e293b; border-radius: 4px;
          color: #e2e8f0; padding: 3px 8px; font-size: 11px; outline: none;
        }
        .cs-p-toolbar input[type="date"]::-webkit-calendar-picker-indicator {
          filter: invert(0.7);
        }
        .cs-p-search-btn {
          background: #3b82f6; color: #fff; border: none; border-radius: 4px;
          padding: 4px 12px; font-size: 11px; font-weight: 600; cursor: pointer;
        }
        .cs-p-search-btn:hover { background: #2563eb; }
        .cs-p-search-btn:disabled { opacity: 0.5; cursor: wait; }

        .cs-p-summary {
          display: flex; gap: 16px; margin-left: auto; align-items: center;
        }
        .cs-p-stat {
          text-align: right;
        }
        .cs-p-stat-label { font-size: 10px; color: #475569; }
        .cs-p-stat-value { font-size: 13px; font-weight: 700; color: #34d399; font-family: monospace; }

        .cs-p-table-wrap {
          overflow-y: auto; flex: 1;
        }
        .cs-p-table {
          width: 100%; border-collapse: collapse; font-size: 11px;
        }
        .cs-p-table thead { position: sticky; top: 0; z-index: 1; }
        .cs-p-table th {
          background: #111125; color: #64748b; font-weight: 600;
          padding: 6px 12px; text-align: right; border-bottom: 1px solid #1e293b;
          white-space: nowrap;
        }
        .cs-p-table th:first-child, .cs-p-table td:first-child { text-align: left; }
        .cs-p-table td {
          padding: 5px 12px; border-bottom: 1px solid #0f0f20;
          text-align: right; font-family: monospace; white-space: nowrap;
        }
        .cs-p-table tbody tr:hover { background: #131530; }
        .cs-p-empty {
          text-align: center; padding: 24px; color: #475569; font-size: 12px;
        }
        .cs-p-collapsed .cs-p-toolbar,
        .cs-p-collapsed .cs-p-table-wrap,
        .cs-p-collapsed .cs-p-mode-btns { display: none; }
        .cs-p-collapsed { max-height: 36px; }
        .cs-p-header { cursor: pointer; }
        .cs-p-header:hover { background: #151530 !important; }
        .cs-p-toggle-icon {
          font-size: 12px; color: #64748b; margin-left: 8px;
          transition: transform 0.2s;
        }
        .cs-p-collapsed .cs-p-toggle-icon { transform: rotate(0deg); }
        .cs-p-expanded .cs-p-toggle-icon { transform: rotate(180deg); }
        .cs-p-count {
          font-size: 11px; color: #3b82f6; margin-left: 8px; font-weight: 400;
        }
        .cs-p-pagination {
          display: flex; justify-content: center; align-items: center; gap: 8px;
          padding: 6px 16px; background: #0d0d1a; border-top: 1px solid #1a1a2e;
          flex-shrink: 0;
        }
        .cs-p-page-btn {
          background: #1e293b; color: #94a3b8; border: 1px solid #334155;
          border-radius: 4px; padding: 3px 10px; font-size: 11px;
          cursor: pointer; min-width: 28px; text-align: center;
        }
        .cs-p-page-btn:hover { background: #334155; color: #e2e8f0; }
        .cs-p-page-btn:disabled { opacity: 0.3; cursor: default; }
        .cs-p-page-btn.current { background: #3b82f6; color: #fff; border-color: #3b82f6; }
        .cs-p-page-info { font-size: 11px; color: #64748b; }
        .cs-p-collapsed .cs-p-pagination { display: none; }
      </style>

      <div class="cs-p-header" id="cs-p-header-toggle">
        <span class="cs-p-title">거래내역 PnL% · 수수료 분석<span class="cs-p-count">${histories.length}건</span><span class="cs-p-toggle-icon">▼</span></span>
        <div class="cs-p-controls">
          <span class="cs-p-mode-btns">
            <button class="cs-p-btn ${currentPnlMode === "margin" ? "active" : ""}" id="cs-mode-margin">마진 기준</button>
            <button class="cs-p-btn ${currentPnlMode === "amount" ? "active" : ""}" id="cs-mode-amount">거래금액 기준</button>
          </span>
          <button class="cs-p-close" id="cs-p-close">✕</button>
        </div>
      </div>

      <div class="cs-p-toolbar">
        <label>회원:</label>
        <select id="cs-p-member">
          <option value="">전체</option>
          ${memberOptions}
        </select>
        <label>시작일:</label>
        <input type="date" id="cs-p-start">
        <label>종료일:</label>
        <input type="date" id="cs-p-end">
        <button class="cs-p-search-btn" id="cs-p-search">수수료 조회</button>

        <div class="cs-p-summary">
          <div class="cs-p-stat">
            <div class="cs-p-stat-label">총 수수료 (현재 목록)</div>
            <div class="cs-p-stat-value" id="cs-p-fee-local">${totalFee.toFixed(6)} USDT</div>
          </div>
          <div class="cs-p-stat">
            <div class="cs-p-stat-label">조회 수수료</div>
            <div class="cs-p-stat-value" id="cs-p-fee-api">— USDT</div>
          </div>
          <div class="cs-p-stat">
            <div class="cs-p-stat-label">거래 회원</div>
            <div class="cs-p-stat-value" id="cs-p-traders">${memberMap.size}명</div>
          </div>
        </div>
      </div>

      <div class="cs-p-table-wrap">
        <table class="cs-p-table">
          <thead>
            <tr>
              <th>회원</th>
              <th>거래쌍</th>
              <th>방향</th>
              <th>레버리지</th>
              <th>거래금액</th>
              <th>손익</th>
              <th>수수료</th>
              <th>PnL%(수수료 미반영)</th>
              <th>PnL%(수수료 반영)</th>
              <th>시간</th>
            </tr>
          </thead>
          <tbody id="cs-p-tbody">
          </tbody>
        </table>
      </div>
      <div class="cs-p-pagination" id="cs-p-pagination"></div>
    `;

    // 테이블 행 렌더링 (페이지네이션)
    currentTablePage = 1;
    renderTablePage();

    // 날짜 설정: 저장된 값이 있으면 복원, 없으면 당일
    const today = new Date();
    const todayStr = today.getFullYear() + "-"
      + String(today.getMonth() + 1).padStart(2, "0") + "-"
      + String(today.getDate()).padStart(2, "0");
    document.getElementById("cs-p-start").value = savedStartDate || todayStr;
    document.getElementById("cs-p-end").value = savedEndDate || todayStr;

    // 패널 상태 복원 (기본: 접힘)
    const savedState = localStorage.getItem("cs-pnl-panel-state");
    if (savedState === "expanded") {
      panel.classList.add("cs-p-expanded");
    } else {
      panel.classList.add("cs-p-collapsed");
    }

    // 이벤트 바인딩
    bindPanelEvents();
  }

  function renderTableRows(histories) {
    const tbody = document.getElementById("cs-p-tbody");
    if (!tbody) return;

    if (!histories || histories.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="cs-p-empty">거래내역이 없습니다. Tapbit에서 동기화하세요.</td></tr>';
      return;
    }

    tbody.innerHTML = histories.map(item => {
      const d = item.data || {};
      const pnl = calcPnl(d, currentPnlMode);
      const profit = parseFloat(d.profit) || 0;
      const fee = parseFloat(d.tradeFee) || 0;
      const side = formatSide(d.side || d.positionSide || d.direction);

      return `<tr>
        <td style="color:#94a3b8; text-align:left; max-width:120px; overflow:hidden; text-overflow:ellipsis;">${esc(item.remarkName || item.maskId || "—")}</td>
        <td style="color:#e2e8f0;">${esc(d.contractName || "—")}</td>
        <td style="color:${side.color}; font-weight:600;">${esc(side.label)}</td>
        <td>${d.leverage || "—"}x</td>
        <td>${formatUsdt(d.tradeAmount)}</td>
        <td style="color:${profit >= 0 ? "#34d399" : "#f87171"}">${formatUsdt(d.profit)}</td>
        <td style="color:#f59e0b">${fee.toFixed(4)}</td>
        <td style="color:${getPnlColor(pnl.pure)}; font-weight:700;">${formatPnl(pnl.pure)}</td>
        <td style="color:${getPnlColor(pnl.withFee)}; font-weight:700;">${formatPnl(pnl.withFee)}</td>
        <td style="color:#64748b; font-size:10px;">${formatTime(d.createTime)}</td>
      </tr>`;
    }).join("");
  }

  // 현재 필터 적용된 목록 가져오기
  function getFilteredHistories() {
    const memberSelect = document.getElementById("cs-p-member");
    const maskId = memberSelect?.value;
    return maskId ? allHistories.filter(h => String(h.maskId) === maskId) : allHistories;
  }

  // 페이지네이션 적용 렌더링
  function renderTablePage() {
    const filtered = getFilteredHistories();
    const totalPages = Math.max(1, Math.ceil(filtered.length / TABLE_PAGE_SIZE));
    if (currentTablePage > totalPages) currentTablePage = totalPages;

    const start = (currentTablePage - 1) * TABLE_PAGE_SIZE;
    const pageItems = filtered.slice(start, start + TABLE_PAGE_SIZE);
    renderTableRows(pageItems);
    renderPagination(filtered.length, totalPages);
  }

  // 페이지네이션 바 렌더링
  function renderPagination(totalItems, totalPages) {
    const paginationEl = document.getElementById("cs-p-pagination");
    if (!paginationEl) return;

    if (totalItems <= TABLE_PAGE_SIZE) {
      paginationEl.innerHTML = "";
      return;
    }

    paginationEl.innerHTML = `
      <button class="cs-p-page-btn" id="cs-p-prev" ${currentTablePage <= 1 ? "disabled" : ""}>&lt;</button>
      <span class="cs-p-page-info">${currentTablePage} / ${totalPages} (${totalItems}건)</span>
      <button class="cs-p-page-btn" id="cs-p-next" ${currentTablePage >= totalPages ? "disabled" : ""}>&gt;</button>
    `;

    document.getElementById("cs-p-prev")?.addEventListener("click", () => {
      if (currentTablePage > 1) { currentTablePage--; renderTablePage(); }
    });
    document.getElementById("cs-p-next")?.addEventListener("click", () => {
      if (currentTablePage < totalPages) { currentTablePage++; renderTablePage(); }
    });
  }

  function bindPanelEvents() {
    // 헤더 클릭 → 접기/펼치기 토글
    document.getElementById("cs-p-header-toggle").addEventListener("click", (e) => {
      // 닫기 버튼이나 모드 버튼 클릭은 제외
      if (e.target.closest(".cs-p-close") || e.target.closest(".cs-p-btn")) return;
      const panel = document.getElementById("cs-pnl-panel");
      const isCollapsed = panel.classList.contains("cs-p-collapsed");
      panel.classList.toggle("cs-p-collapsed");
      panel.classList.toggle("cs-p-expanded");
      const icon = panel.querySelector(".cs-p-toggle-icon");
      if (icon) icon.textContent = isCollapsed ? "▲" : "▼";
      // 상태 저장
      localStorage.setItem("cs-pnl-panel-state", isCollapsed ? "expanded" : "collapsed");
    });

    // 모드 전환 (이벤트 버블링 막기)
    document.getElementById("cs-mode-margin").addEventListener("click", (e) => {
      e.stopPropagation();
      currentPnlMode = "margin";
      document.getElementById("cs-mode-margin").classList.add("active");
      document.getElementById("cs-mode-amount").classList.remove("active");
      renderTablePage();
    });
    document.getElementById("cs-mode-amount").addEventListener("click", (e) => {
      e.stopPropagation();
      currentPnlMode = "amount";
      document.getElementById("cs-mode-amount").classList.add("active");
      document.getElementById("cs-mode-margin").classList.remove("active");
      renderTablePage();
    });

    // 닫기
    document.getElementById("cs-p-close").addEventListener("click", (e) => {
      e.stopPropagation();
      const panel = document.getElementById("cs-pnl-panel");
      panel.style.display = "none";
    });

    // 회원 필터
    document.getElementById("cs-p-member").addEventListener("change", () => {
      currentTablePage = 1;
      renderTablePage();
      updateLocalFeeSum();
    });

    // 수수료 조회 (summary API)
    document.getElementById("cs-p-search").addEventListener("click", fetchFeeSummary);
  }

  function updateLocalFeeSum() {
    const tbody = document.getElementById("cs-p-tbody");
    const feeEl = document.getElementById("cs-p-fee-local");
    if (!tbody || !feeEl) return;

    const memberSelect = document.getElementById("cs-p-member");
    const maskId = memberSelect?.value;
    const list = maskId
      ? allHistories.filter(h => String(h.maskId) === maskId)
      : allHistories;

    let total = 0;
    list.forEach(item => { total += parseFloat(item.data?.tradeFee) || 0; });
    feeEl.textContent = total.toFixed(6) + " USDT";
  }

  function fetchFeeSummary() {
    const startInput = document.getElementById("cs-p-start");
    const endInput = document.getElementById("cs-p-end");
    const memberSelect = document.getElementById("cs-p-member");
    const searchBtn = document.getElementById("cs-p-search");
    const feeEl = document.getElementById("cs-p-fee-api");
    const tradersEl = document.getElementById("cs-p-traders");

    if (!startInput.value || !endInput.value) {
      feeEl.textContent = "날짜를 선택하세요";
      feeEl.style.color = "#f87171";
      return;
    }

    // 사용자 선택 날짜 저장 (re-render 시 복원용)
    savedStartDate = startInput.value;
    savedEndDate = endInput.value;
    isFeeQuerying = true;

    // UTC 기준 타임스탬프 (Tapbit API 형식과 일치)
    const startTime = new Date(startInput.value + "T00:00:00.000Z").getTime();
    const endTime = new Date(endInput.value + "T23:59:59.999Z").getTime();
    console.log("[Coinstep] Fee query:", startInput.value, "~", endInput.value, "startTime:", startTime, "endTime:", endTime, "member:", memberSelect.value);

    feeEl.textContent = "조회 중...";
    feeEl.style.color = "#64748b";
    searchBtn.disabled = true;

    chrome.runtime.sendMessage({
      type: "FETCH_SUMMARY",
      startTime,
      endTime,
      userType: memberSelect.value || "",
    }, (response) => {
      searchBtn.disabled = false;
      isFeeQuerying = false;
      console.log("[Coinstep] Fee response:", JSON.stringify(response), "lastError:", chrome.runtime.lastError?.message);

      if (chrome.runtime.lastError || response?.error) {
        const rawErr = chrome.runtime.lastError?.message || response?.error || "UNKNOWN";
        console.error("[Coinstep] Summary error:", rawErr);
        let errMsg;
        if (response?.error === "AUTH_NOT_FOUND") {
          errMsg = "인증 만료. Tapbit 새로고침 필요";
        } else if (rawErr.includes("HTTP_")) {
          errMsg = "API 오류";
        } else {
          errMsg = "조회 실패";
        }
        feeEl.innerHTML = esc(errMsg) + ' <button id="cs-p-retry" style="background:#334155;color:#e2e8f0;border:1px solid #475569;border-radius:3px;padding:1px 8px;font-size:10px;cursor:pointer;margin-left:6px;">재시도</button>';
        feeEl.style.color = "#f87171";
        document.getElementById("cs-p-retry")?.addEventListener("click", fetchFeeSummary);
        return;
      }

      const data = response?.data;
      if (data) {
        const fee = parseFloat(data.totalCustomerTradeFees || 0);
        const countInfo = " (" + data.recordCount + "건)";
        const partialTag = data.partial ? " [부분]" : "";
        feeEl.textContent = fee.toFixed(6) + " USDT" + countInfo + partialTag;
        feeEl.style.color = data.partial ? "#f59e0b" : "#34d399";
        tradersEl.textContent = (data.totalCustomerTraders || "0") + "명";

        // 조회 결과를 테이블에 반영
        if (response.items && response.items.length > 0) {
          allHistories = response.items;
          currentTablePage = 1;
          // 건수 업데이트
          const countEl = document.querySelector(".cs-p-count");
          if (countEl) countEl.textContent = allHistories.length + "건";
          // 회원 목록 업데이트
          const memberSelect = document.getElementById("cs-p-member");
          const currentMember = memberSelect?.value || "";
          const memberMap = new Map();
          allHistories.forEach(item => {
            if (item.maskId && !memberMap.has(item.maskId)) {
              memberMap.set(item.maskId, item.remarkName || "회원 " + item.maskId);
            }
          });
          if (memberSelect) {
            memberSelect.innerHTML = '<option value="">전체</option>'
              + Array.from(memberMap.entries())
                .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`)
                .join("");
            memberSelect.value = currentMember;
          }
          renderTablePage();
          updateLocalFeeSum();
        }
      } else {
        feeEl.textContent = "데이터 없음";
        feeEl.style.color = "#f87171";
      }
    });
  }

  console.log("[Coinstep] Calculator content script loaded");
})();
