/**
 * Coinstep Sync Bookmarklet — agent.tapbit.com 에서 실행
 *
 * 역할:
 * 1. fetch intercept로 Tapbit API 응답 캡처 (inject-tapbit.js 없이도 동작)
 * 2. dva store에서 positions, accounts, profile 읽기
 * 3. histories: filtersChange + pageChange dispatch로 전체 페이지 수집
 * 4. Backend API (POST /api/sync)로 전송
 *
 * 기존 extensions/inject-tapbit.js + background.js 로직을 통합 이식
 */
(function () {
  "use strict";

  // ── 설정 ──
  var BACKEND_URL = "https://api.coinstep.co.kr";
  var PAGE_SIZE = 100;
  var MAX_PAGES = 50; // 최대 5000건
  var TIMEOUT_MS = 30000; // 30초
  var MSG_TYPE = "__COINSTEP_SYNC_HISTORIES__"; // 고유 메시지 타입 (inject-tapbit.js와 충돌 방지)

  // ── 중복 실행 방지 ──
  if (window.__COINSTEP_SYNCING) {
    showToast("이미 동기화 중입니다", "warn");
    return;
  }
  window.__COINSTEP_SYNCING = true;

  // ── fetch intercept 설치 (histories 응답 캡처용) ──
  installFetchIntercept();

  // ── 메인 실행 ──
  main().catch(function (err) {
    console.error("[Coinstep Sync] Error:", err);
    showToast("동기화 실패: " + err.message, "error");
  }).finally(function () {
    window.__COINSTEP_SYNCING = false;
    removeFetchIntercept();
  });

  function main() {
    return new Promise(function (resolve, reject) {
      try {
        // 1. dva store 확인
        var store = window.g_app && window.g_app._store;
        if (!store) {
          throw new Error("Tapbit 페이지에서 실행하세요 (dva store 없음)");
        }

        showToast("동기화 시작...", "info");

        // 2. SyncToken 확인
        var syncToken = localStorage.getItem("coinstep_sync_token");
        if (!syncToken) {
          syncToken = prompt(
            "Coinstep SyncToken을 입력하세요:\n" +
            "(관리자에게 발급받은 stk_로 시작하는 토큰)"
          );
          if (!syncToken || !syncToken.startsWith("stk_")) {
            throw new Error("유효한 SyncToken이 필요합니다 (stk_로 시작)");
          }
          localStorage.setItem("coinstep_sync_token", syncToken);
        }

        // 3. 프로필 수집
        showToast("프로필 수집 중...", "info");
        var profile = collectProfile(store);

        // 4. 포지션/계좌 수집 (store에서 직접 읽기)
        showToast("포지션/계좌 수집 중...", "info");
        var positions = collectFromStore(store, "positions");
        var accounts = collectFromStore(store, "accounts");

        // 5. 거래내역 수집 (dva dispatch + pagination)
        showToast("거래내역 수집 중... (페이지 1)", "info");
        collectHistories(store).then(function (histories) {
          console.log("[Coinstep Sync] 수집 완료:", {
            profile: profile,
            positions: positions.length,
            accounts: accounts.length,
            histories: histories.length,
          });

          // 6. Backend 전송
          showToast("서버로 전송 중... (" + histories.length + "건)", "info");

          return fetch(BACKEND_URL + "/api/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "SyncToken " + syncToken,
            },
            body: JSON.stringify({
              profile: profile,
              positions: positions,
              accounts: accounts,
              histories: histories,
            }),
          });
        }).then(function (response) {
          return response.json().then(function (result) {
            return { ok: response.ok, status: response.status, data: result };
          });
        }).then(function (resp) {
          if (!resp.ok) {
            if (resp.status === 401) {
              localStorage.removeItem("coinstep_sync_token");
            }
            if (resp.status === 429) {
              var retryAfter = resp.data.retryAfter || 60;
              throw new Error("요청이 너무 많습니다. " + retryAfter + "초 후 다시 시도하세요.");
            }
            if (resp.status === 409 && resp.data.error === "DUPLICATE_REQUEST") {
              throw new Error("동일한 데이터가 최근에 이미 동기화되었습니다.");
            }
            throw new Error(resp.data.message || resp.data.error || "서버 오류 " + resp.status);
          }

          var counts = resp.data.counts || {};
          var msg = "동기화 완료!\n" +
            "포지션: " + (counts.positions || 0) + "\n" +
            "계좌: " + (counts.accounts || 0) + "\n" +
            "거래내역: +" + (counts.historiesInserted || 0) +
            (counts.historiesSkipped ? "\n중복 스킵: " + counts.historiesSkipped : "");

          showToast(msg, "success", 5000);
          console.log("[Coinstep Sync] Result:", resp.data);
          resolve(resp.data);
        }).catch(function (err) {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // ── fetch intercept: Tapbit /histories 응답을 캡처 ──
  function installFetchIntercept() {
    if (window.__coinstepOriginalFetch) return; // 이미 설치됨

    window.__coinstepOriginalFetch = window.fetch;
    window.fetch = function () {
      var args = arguments;
      var url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";

      return window.__coinstepOriginalFetch.apply(this, args).then(function (result) {
        // /histories 응답 캡처
        if (url.indexOf("agent-api.tapbit.com") !== -1 &&
            url.indexOf("/agent/contract/order/histories") !== -1) {
          try {
            var cloned = result.clone();
            cloned.json().then(function (json) {
              if (json && json.data && json.data.list) {
                window.postMessage({
                  type: MSG_TYPE,
                  data: json.data,
                }, "*");
              }
            }).catch(function () {});
          } catch (e) {}
        }

        // /positions 응답 캡처 (store에 없을 때 대안)
        if (url.indexOf("agent-api.tapbit.com") !== -1 &&
            url.indexOf("/agent/contract/positions") !== -1 &&
            url.indexOf("contractType=") !== -1) {
          try {
            var cloned2 = result.clone();
            cloned2.json().then(function (json) {
              if (json && json.data && json.data.list) {
                window.__coinstepCapturedPositions = json.data.list;
              }
            }).catch(function () {});
          } catch (e) {}
        }

        // /accounts 응답 캡처
        if (url.indexOf("agent-api.tapbit.com") !== -1 &&
            url.indexOf("/agent/accounts") !== -1 &&
            url.indexOf("contractType=") !== -1) {
          try {
            var cloned3 = result.clone();
            cloned3.json().then(function (json) {
              if (json && json.data && json.data.list) {
                window.__coinstepCapturedAccounts = json.data.list;
              }
            }).catch(function () {});
          } catch (e) {}
        }

        // /profile 응답 캡처
        if (url.indexOf("agent-api.tapbit.com") !== -1 &&
            url.indexOf("/agent/profile") !== -1) {
          try {
            var cloned4 = result.clone();
            cloned4.json().then(function (json) {
              if (json && json.data && json.data.maskId) {
                window.__coinstepCapturedProfile = {
                  maskId: json.data.maskId,
                  remarkName: json.data.remarkName || "",
                };
              }
            }).catch(function () {});
          } catch (e) {}
        }

        return result;
      });
    };
    console.log("[Coinstep Sync] Fetch intercept installed");
  }

  function removeFetchIntercept() {
    if (window.__coinstepOriginalFetch) {
      window.fetch = window.__coinstepOriginalFetch;
      delete window.__coinstepOriginalFetch;
      console.log("[Coinstep Sync] Fetch intercept removed");
    }
    delete window.__coinstepCapturedPositions;
    delete window.__coinstepCapturedAccounts;
    delete window.__coinstepCapturedProfile;
  }

  // ── 프로필 수집 ──
  function collectProfile(store) {
    var state = store.getState();

    // 캡처된 프로필이 있으면 사용
    if (window.__coinstepCapturedProfile) {
      return window.__coinstepCapturedProfile;
    }

    // dva store에서 검색
    var maskId = "";
    var remarkName = "";

    // items.profile 확인
    var items = state.items || {};
    if (items.profile && items.profile.maskId) {
      maskId = items.profile.maskId;
      remarkName = items.profile.remarkName || "";
    }

    // 없으면 store 전체 탐색
    if (!maskId) {
      var keys = Object.keys(state);
      for (var i = 0; i < keys.length; i++) {
        var val = state[keys[i]];
        if (val && typeof val === "object") {
          if (val.maskId) {
            maskId = val.maskId;
            remarkName = val.remarkName || remarkName;
            break;
          }
          if (val.profile && val.profile.maskId) {
            maskId = val.profile.maskId;
            remarkName = val.profile.remarkName || remarkName;
            break;
          }
        }
      }
    }

    if (!maskId) {
      throw new Error("프로필(maskId)을 찾을 수 없습니다. 페이지를 새로고침 후 다시 시도하세요.");
    }

    return { maskId: maskId, remarkName: remarkName };
  }

  // ── store에서 데이터 수집 (positions/accounts) ──
  function collectFromStore(store, type) {
    var state = store.getState();
    var lists = state.lists || {};

    // lists 모델에서 해당 타입 데이터 찾기
    var keys = Object.keys(lists);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var val = lists[key];
      if (val && val.items && Array.isArray(val.items) && key.toLowerCase().indexOf(type) !== -1) {
        if (val.items.length > 0) {
          return val.items;
        }
      }
    }

    // 캡처된 데이터 확인
    if (type === "positions" && window.__coinstepCapturedPositions) {
      return window.__coinstepCapturedPositions;
    }
    if (type === "accounts" && window.__coinstepCapturedAccounts) {
      return window.__coinstepCapturedAccounts;
    }

    console.log("[Coinstep Sync] " + type + " not found in store, returning empty");
    return [];
  }

  // ── 거래내역 수집 (dva dispatch + pagination) ──
  // background.js FETCH_SUMMARY 로직 이식
  function collectHistories(store) {
    return new Promise(function (resolve) {
      var allItems = [];
      var currentPage = 1;

      var handler = function (e) {
        if (e.source !== window || !e.data || e.data.type !== MSG_TYPE) return;

        var data = e.data.data || {};
        var list = data.list || [];

        console.log("[Coinstep Sync] Page " + currentPage + ": " + list.length + " items");
        showToast(
          "거래내역 수집 중... (페이지 " + currentPage + ", " + (allItems.length + list.length) + "건)",
          "info"
        );

        for (var i = 0; i < list.length; i++) {
          allItems.push(list[i]);
        }

        // 다음 페이지 필요 여부 (total=-1인 API이므로 list.length로 판단)
        if (list.length === PAGE_SIZE && currentPage < MAX_PAGES) {
          currentPage++;
          store.dispatch({
            type: "lists/pageChange",
            payload: {
              id: "historyOrders",
              page: { current: currentPage },
            },
          });
        } else {
          // 모든 페이지 수집 완료
          window.removeEventListener("message", handler);
          clearTimeout(timeout);
          resolve(allItems);
        }
      };

      window.addEventListener("message", handler);

      // 타임아웃 (부분 데이터도 전송)
      var timeout = setTimeout(function () {
        window.removeEventListener("message", handler);
        console.log("[Coinstep Sync] Timeout with " + allItems.length + " items");
        if (allItems.length > 0) {
          showToast("타임아웃 — " + allItems.length + "건 수집됨 (부분)", "warn");
        }
        resolve(allItems);
      }, TIMEOUT_MS);

      // 날짜 범위: 최근 180일
      var now = Date.now();
      var startTime = now - 180 * 24 * 60 * 60 * 1000;
      var endTime = now;

      console.log("[Coinstep Sync] Dispatching filtersChange for histories");
      store.dispatch({
        type: "lists/filtersChange",
        payload: {
          id: "historyOrders",
          filters: {
            contractType: "USDT_MARGIN_CONTRACT",
            startTime: String(startTime),
            endTime: String(endTime),
          },
        },
      });
    });
  }

  // ── Toast UI ──
  function showToast(message, type, duration) {
    type = type || "info";
    duration = duration || 3000;

    var existing = document.getElementById("coinstep-toast");
    if (existing) existing.remove();

    var colors = {
      info: "#1890ff",
      success: "#52c41a",
      error: "#ff4d4f",
      warn: "#faad14",
    };

    var toast = document.createElement("div");
    toast.id = "coinstep-toast";
    toast.style.cssText =
      "position:fixed;top:20px;right:20px;z-index:999999;" +
      "padding:12px 20px;border-radius:8px;font-size:14px;line-height:1.5;" +
      "white-space:pre-line;max-width:350px;" +
      "box-shadow:0 4px 12px rgba(0,0,0,0.3);" +
      "background:" + (colors[type] || colors.info) + ";" +
      "color:#fff;" +
      "font-family:-apple-system,BlinkMacSystemFont,sans-serif;" +
      "transition:opacity 0.3s;";
    toast.textContent = message;
    document.body.appendChild(toast);

    if (type !== "info") {
      setTimeout(function () {
        toast.style.opacity = "0";
        setTimeout(function () {
          if (toast.parentNode) toast.remove();
        }, 300);
      }, duration);
    }
  }
})();
