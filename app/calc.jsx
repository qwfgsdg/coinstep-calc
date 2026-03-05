import { useState, useCallback, useMemo, useEffect, useRef, Fragment } from "react";

/* ═══════════════════════════════════════════
   CONSTANTS & UTILITIES
   ═══════════════════════════════════════════ */
const uid = () => Math.random().toString(36).slice(2, 9);
const n = (v) => Number(v) || 0;
const fmt = (v, d = 2) =>
  v != null && isFinite(v)
    ? Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
    : "—";
const fmtS = (v, d = 2) => (v >= 0 ? "+" : "") + fmt(v, d);
const pct = (a, b) => (b !== 0 ? (a / b) * 100 : 0);

const COIN_QTY_STEPS = {
  BTC: 0.001, ETH: 0.01, SOL: 0.1, XRP: 1,
  DOGE: 1, ADA: 1, AVAX: 0.1, LINK: 0.1,
};

function fromInput(input, entry, lev, fee, dir, coin) {
  if (!input || !entry || !lev) return null;
  const step = COIN_QTY_STEPS[coin] || 0.001;
  const bkPrice = dir === "long"
    ? entry * (lev - 1) / lev
    : entry * (lev + 1) / lev;
  const costPerQty = entry / lev + entry * fee + bkPrice * fee;
  if (costPerQty <= 0) return null;
  const rawQty = input / costPerQty;
  const qty = Math.floor(rawQty / step) * step;
  if (qty <= 0) return null;
  const size = qty * entry;
  const margin = size / lev;
  const openCost = size * fee;
  const closeCost = qty * bkPrice * fee;
  return { margin, qty, size, openCost, closeCost,
           total: margin + openCost + closeCost,
           change: input - (margin + openCost + closeCost), bkPrice };
}

function fromDisplay(margin, entry, lev, fee, dir) {
  if (!margin || !entry || !lev) return margin;
  const qty = margin * lev / entry;
  const bkPrice = dir === "long"
    ? entry * (lev - 1) / lev
    : entry * (lev + 1) / lev;
  return margin + qty * entry * fee + qty * bkPrice * fee;
}

const mkDCA = () => ({ id: uid(), price: "", margin: "" });
const mkPyra = () => ({ id: uid(), price: "", margin: "" });
const LEV_PRESETS = [5, 10, 20, 25, 50, 75, 100, 125];

/* ═══════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════ */
export default function SimV4() {
  // ── 데이터 소스 (Tapbit 동기화) ──
  const [tapbitData, setTapbitData] = useState(null);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [lastSyncTime, setLastSyncTime] = useState(null);

  // ── 로컬 편집 가능 상태 (selectedUser에서 자동 채움, 시뮬레이션 시 수정 가능) ──
  const [wallet, setWallet] = useState("");
  const [coinPrices, setCoinPrices] = useState({});
  const [coinLiqPrices, setCoinLiqPrices] = useState({});
  const [positions, setPositions] = useState([]);
  const feeRate = "0.04"; // Tapbit 고정
  const setLiqPrice = (coin, val) => setCoinLiqPrices(prev => ({ ...prev, [coin]: val }));
  const getLiqPrice = (coin) => n(coinLiqPrices[coin] || "");

  // ── 실시간 가격 (Tapbit WebSocket) ──
  const [priceSource, setPriceSource] = useState("connecting");
  const [coinFundingRates, setCoinFundingRates] = useState({});
  const priceBufferRef = useRef({});
  const wsRef = useRef(null);
  const reconnectRef = useRef(0);
  const flushTimerRef = useRef(null);
  const priceDirTimer = useRef(null);

  const priceSourceLabel = { "tapbit-ws": "Tapbit 실시간", "reconnecting": "재연결 중...", "binance-rest": "Binance 대체", "disconnected": "연결 안 됨" }[priceSource] || "";
  const priceSourceColor = { "tapbit-ws": "#34d399", "reconnecting": "#f59e0b", "binance-rest": "#0ea5e9", "disconnected": "#6b7280" }[priceSource] || "#6b7280";

  // ── 시뮬레이션 State (전부 유지) ──
  const [selId, setSelId] = useState(null);
  const [dcaMode, setDcaMode] = useState("sim");
  const [dcaEntries, setDcaEntries] = useState([mkDCA()]);
  const [revPrice, setRevPrice] = useState("");
  const [revTarget, setRevTarget] = useState("");
  const [targetAvail, setTargetAvail] = useState("");
  const [closeRatio, setCloseRatio] = useState("50");
  const [closePrice, setClosePrice] = useState("");

  const [hedgeId, setHedgeId] = useState(null);
  const [hedgeEntry, setHedgeEntry] = useState("");
  const [hedgeMargin, setHedgeMargin] = useState("");
  const [hedgeLev, setHedgeLev] = useState("");
  const [hedgeLive, setHedgeLive] = useState(true);
  const [splitMode, setSplitMode] = useState(false);
  const [splitTotal, setSplitTotal] = useState("");
  const [splitPrices, setSplitPrices] = useState(["", "", ""]);

  const [pyraMode, setPyraMode] = useState(false);
  const [pyraLockedId, setPyraLockedId] = useState(null);
  const [pyraCounterId, setPyraCounterId] = useState(null);
  const [pyraSubMode, setPyraSubMode] = useState("sim");
  const [pyraEntries, setPyraEntries] = useState([mkPyra()]);
  const [pyraRevPrice, setPyraRevPrice] = useState("");
  const [pyraRevTarget, setPyraRevTarget] = useState("");
  const [pyraSplitMode, setPyraSplitMode] = useState(false);
  const [pyraSplitTotal, setPyraSplitTotal] = useState("");
  const [pyraSplitPrices, setPyraSplitPrices] = useState(["", "", ""]);

  const [scCloseRatios, setScCloseRatios] = useState({});
  const [scTargets, setScTargets] = useState({});
  const getScRatio = (coin, dir) => scCloseRatios[coin]?.[dir] || "100";
  const setScRatio = (coin, dir, val) => setScCloseRatios(prev => ({ ...prev, [coin]: { ...(prev[coin] || {}), [dir]: val } }));
  const getScTarget = (coin) => scTargets[coin] || "";
  const setScTarget = (coin, val) => setScTargets(prev => ({ ...prev, [coin]: val }));

  const [appTab, setAppTab] = useState("sim");
  const [hcMargin, setHcMargin] = useState("1000");
  const [hcLeverage, setHcLeverage] = useState("100");
  const [hcTakeROE, setHcTakeROE] = useState("40");
  const [hcCutRatio, setHcCutRatio] = useState("50");
  const [hcRecoveryROE, setHcRecoveryROE] = useState("0");
  const [hcKillPct, setHcKillPct] = useState("15");
  const [hcLongEntry, setHcLongEntry] = useState("");
  const [hcShortEntry, setHcShortEntry] = useState("");
  const [hcLongMargin, setHcLongMargin] = useState("");
  const [hcShortMargin, setHcShortMargin] = useState("");
  const [hcCycles, setHcCycles] = useState([]);

  // ── 파생 값 ──
  const usedCoins = useMemo(() => [...new Set(positions.map(p => p.coin))].sort(), [positions]);
  const getCp = (coin) => n(coinPrices[coin] || "");
  const setCp = (coin, val) => setCoinPrices(prev => ({ ...prev, [coin]: val }));
  const primaryCoin = usedCoins[0] || "BTC";
  const hasAnyPrice = usedCoins.some(c => getCp(c) > 0);

  // ── 유저 파싱 (tapbitData → 구조화) ──
  const parsedUsers = useMemo(() => {
    if (!tapbitData?.positions?.length) return [];
    const userMap = {};
    tapbitData.positions.forEach(item => {
      const id = item.maskId;
      if (!userMap[id]) {
        userMap[id] = { maskId: id, label: item.remarkName || item.nickname || `User-${id}`, positions: [], wallet: "0" };
      }
      if (item.data) {
        const d = item.data;
        userMap[id].positions.push({
          id: `${id}-${d.contractName}-${d.direction}`,
          coin: (d.contractName || "").replace("USDT", ""),
          dir: d.direction === 1 ? "long" : "short",
          entryPrice: String(d.averagePrice),
          margin: String(d.margin),
          leverage: Number(d.leverage),
          liquidationPrice: String(d.liquidationPrice || ""),
          unrealisedPnl: String(d.unrealisedPnl || "0"),
          roe: String(d.roe || "0"),
        });
      }
    });
    (tapbitData.accounts || []).forEach(item => {
      if (userMap[item.maskId] && item.data) userMap[item.maskId].wallet = item.data.contractAmount || "0";
    });
    return Object.values(userMap).filter(u => u.positions.length > 0).sort((a, b) => Number(b.wallet) - Number(a.wallet));
  }, [tapbitData]);

  const selectedUser = useMemo(() => {
    if (!selectedUserId) return null;
    return parsedUsers.find(u => u.maskId === selectedUserId) || null;
  }, [parsedUsers, selectedUserId]);

  // ── selectedUser 변경 → 로컬 상태 동기화 ──
  useEffect(() => {
    if (!selectedUser) return;
    setWallet(selectedUser.wallet);
    setPositions(selectedUser.positions);
    const liqMap = {};
    selectedUser.positions.forEach(p => {
      if (p.liquidationPrice && !liqMap[p.coin]) liqMap[p.coin] = p.liquidationPrice;
    });
    setCoinLiqPrices(liqMap);
    // 시뮬레이션 상태 초기화
    setSelId(null); setHedgeId(null);
    setPyraMode(false); setPyraLockedId(null); setPyraCounterId(null);
    setDcaEntries([mkDCA()]); setDcaMode("sim");
  }, [selectedUser]);

  // selectedUser 사라짐 체크
  useEffect(() => {
    if (selectedUserId && parsedUsers.length > 0 && !parsedUsers.find(u => u.maskId === selectedUserId)) {
      setSelectedUserId(null);
      setPositions([]); setWallet("");
    }
  }, [parsedUsers, selectedUserId]);

  // ── Tapbit 동기화 수신 (chrome.storage → content-calc.js → 여기) ──
  useEffect(() => {
    const onSync = (e) => {
      const data = e.detail;
      if (!data?.success) return;
      setTapbitData({ positions: data.positions || [], accounts: data.accounts || [], profile: data.profile });
      setLastSyncTime(data.lastSync || Date.now());
    };
    window.addEventListener("tapbit-sync-response", onSync);

    // 마운트 후 데이터 요청 (content-calc.js가 storage에서 읽어서 전달)
    const t1 = setTimeout(() => window.postMessage({ type: "CALC_READ_DATA" }, "*"), 500);
    const t2 = setTimeout(() => window.postMessage({ type: "CALC_READ_DATA" }, "*"), 2000);
    const t3 = setTimeout(() => window.postMessage({ type: "CALC_READ_DATA" }, "*"), 5000);

    return () => {
      window.removeEventListener("tapbit-sync-response", onSync);
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
    };
  }, []);

  // ── Tapbit WebSocket 가격 엔진 (항상 연결) ──
  useEffect(() => {
    const binanceIntervalRef = { current: null };
    let binanceController = null;

    const startBinanceFallback = () => {
      setPriceSource("binance-rest");
      const controller = new AbortController();
      const fetchPrices = async () => {
        try {
          const coins = usedCoins.length > 0 ? usedCoins : ["BTC", "ETH"];
          const results = await Promise.all(
            coins.map(coin =>
              fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${coin}USDT`, { signal: controller.signal })
                .then(r => r.json()).then(d => ({ coin, price: String(parseFloat(d.price)) }))
            )
          );
          setCoinPrices(prev => {
            const next = { ...prev }; let changed = false;
            results.forEach(({ coin, price }) => { if (next[coin] !== price) { next[coin] = price; changed = true; } });
            return changed ? next : prev;
          });
        } catch (e) { if (e.name === "AbortError") return; }
      };
      const scheduleNext = () => {
        const ms = document.hidden ? 10000 : 3000;
        clearTimeout(binanceIntervalRef.current);
        binanceIntervalRef.current = setTimeout(async () => { await fetchPrices(); scheduleNext(); }, ms);
      };
      fetchPrices().then(scheduleNext);
      return controller;
    };

    const connectTapbitWS = () => {
      try {
        const ws = new WebSocket("wss://ws-openapi.tapbit.com/stream/ws");
        wsRef.current = ws;
        ws.onopen = () => {
          ws.send(JSON.stringify({ op: "subscribe", args: ["usdt/ticker.all"] }));
          setPriceSource("tapbit-ws");
          reconnectRef.current = 0;
          if (binanceController) { binanceController.abort(); binanceController = null; }
          clearTimeout(binanceIntervalRef.current);
        };
        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (!msg.data || !Array.isArray(msg.data)) return;
            msg.data.forEach(t => {
              const coin = (t.symbol || "").replace("-SWAP", "");
              if (!coin) return;
              priceBufferRef.current[coin] = { mark: t.markPrice || t.lastPrice, funding: t.fundingRate };
            });
          } catch (err) {}
        };
        ws.onclose = () => {
          reconnectRef.current++;
          if (reconnectRef.current <= 5) {
            setPriceSource("reconnecting");
            setTimeout(connectTapbitWS, Math.min(1000 * Math.pow(2, reconnectRef.current), 30000));
          } else { binanceController = startBinanceFallback(); }
        };
        ws.onerror = () => { if (ws.readyState !== WebSocket.CLOSED) ws.close(); };
      } catch (err) { binanceController = startBinanceFallback(); }
    };

    connectTapbitWS();

    flushTimerRef.current = setInterval(() => {
      const buf = priceBufferRef.current;
      const coins = Object.keys(buf);
      if (coins.length === 0) return;
      setCoinPrices(prev => {
        const next = { ...prev }; let changed = false;
        coins.forEach(coin => { const val = buf[coin].mark; if (val && next[coin] !== val) { next[coin] = val; changed = true; } });
        return changed ? next : prev;
      });
      setCoinFundingRates(prev => {
        const next = { ...prev }; let changed = false;
        coins.forEach(coin => { if (buf[coin].funding && next[coin] !== buf[coin].funding) { next[coin] = buf[coin].funding; changed = true; } });
        return changed ? next : prev;
      });
      priceBufferRef.current = {};
    }, 500);

    const onVis = () => {
      if (!document.hidden && priceSource !== "tapbit-ws") {
        reconnectRef.current = 0;
        if (wsRef.current) wsRef.current.close();
        connectTapbitWS();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      if (binanceController) binanceController.abort();
      clearInterval(flushTimerRef.current);
      clearTimeout(binanceIntervalRef.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // ── 헷지 진입가 실시간 연동 ──
  useEffect(() => {
    if (!hedgeLive || !hedgeId) return;
    const targetPos = positions.find(p => p.id === hedgeId);
    if (!targetPos) return;
    const cp = n(coinPrices[targetPos.coin] || "");
    if (cp > 0) setHedgeEntry(prev => n(prev) === cp ? prev : String(cp));
  }, [hedgeLive, hedgeId, coinPrices, positions]);

  // ── 유저 선택 ──
  const selectUser = useCallback((maskId) => {
    setSelectedUserId(prev => prev === maskId ? null : maskId);
  }, []);

  // ── 포지션 관련 함수 ──
  const updPos = useCallback((id, k, v) =>
    setPositions(ps => ps.map(p => (p.id === id ? { ...p, [k]: v } : p))), []);
  const selectPos = (id) => {
    setSelId(prev => (prev === id ? null : id));
    setDcaEntries([mkDCA()]); setRevPrice(""); setRevTarget(""); setDcaMode("sim");
    setHedgeId(null); setPyraMode(false); setPyraLockedId(null); setPyraCounterId(null);
  };
  const selectHedge = (id) => {
    if (hedgeId === id) { setHedgeId(null); return; }
    setSelId(null); setPyraMode(false); setPyraLockedId(null); setPyraCounterId(null);
    setHedgeId(id);
    const targetPos = positions.find(p => p.id === id);
    const cp = targetPos ? n(coinPrices[targetPos.coin] || "") : 0;
    setHedgeEntry(cp > 0 ? String(cp) : "");
    setHedgeLive(true); setHedgeMargin(""); setHedgeLev("");
  };
  const selectPyra = (pyraTargetId) => {
    if (pyraMode && pyraCounterId === pyraTargetId) {
      setPyraMode(false); setPyraLockedId(null); setPyraCounterId(null); return;
    }
    setSelId(null); setHedgeId(null);
    const target = positions.find(p => p.id === pyraTargetId);
    if (!target) return;
    setPyraMode(true); setPyraCounterId(pyraTargetId);
    setPyraSubMode("sim"); setPyraEntries([mkPyra()]);
    setPyraRevPrice(""); setPyraRevTarget(""); setPyraSplitMode(false);
    const lockedDir = target.dir === "long" ? "short" : "long";
    const candidates = positions.filter(p => p.id !== pyraTargetId && p.dir === lockedDir && p.coin === target.coin);
    setPyraLockedId(candidates.length === 1 ? candidates[0].id : null);
  };

  const addDCA = () => setDcaEntries(d => [...d, mkDCA()]);
  const rmDCA = (id) => setDcaEntries(d => d.filter(x => x.id !== id));
  const updDCA = useCallback((id, k, v) => setDcaEntries(ds => ds.map(d => (d.id === id ? { ...d, [k]: v } : d))), []);
  const addPyra = () => setPyraEntries(d => [...d, mkPyra()]);
  const rmPyra = (id) => setPyraEntries(d => d.filter(x => x.id !== id));
  const updPyra = useCallback((id, k, v) => setPyraEntries(ds => ds.map(d => (d.id === id ? { ...d, [k]: v } : d))), []);

  const openSplitHelper = () => {
    if (!splitMode) {
      const prices = dcaEntries.map(e => e.price).filter(p => n(p) > 0);
      const total = dcaEntries.reduce((a, e) => a + n(e.margin), 0);
      if (prices.length > 0) { setSplitPrices(prices.length > 0 ? prices : ["", "", ""]); if (total > 0) setSplitTotal(String(Math.round(total * 100) / 100)); }
    }
    setSplitMode(!splitMode);
  };
  const addSplitPrice = () => setSplitPrices(p => [...p, ""]);
  const rmSplitPrice = (idx) => setSplitPrices(p => p.filter((_, i) => i !== idx));
  const updSplitPrice = (idx, v) => setSplitPrices(p => p.map((x, i) => (i === idx ? v : x)));

  const openPyraSplitHelper = () => {
    if (!pyraSplitMode) {
      const prices = pyraEntries.map(e => e.price).filter(p => n(p) > 0);
      const total = pyraEntries.reduce((a, e) => a + n(e.margin), 0);
      if (prices.length > 0) { setPyraSplitPrices(prices); if (total > 0) setPyraSplitTotal(String(Math.round(total * 100) / 100)); }
    }
    setPyraSplitMode(!pyraSplitMode);
  };
  const addPyraSplitPrice = () => setPyraSplitPrices(p => [...p, ""]);
  const rmPyraSplitPrice = (idx) => setPyraSplitPrices(p => p.filter((_, i) => i !== idx));
  const updPyraSplitPrice = (idx, v) => setPyraSplitPrices(p => p.map((x, i) => (i === idx ? v : x)));

  /* ═══════════════════════════════════════════
     CORE CALCULATIONS
     ═══════════════════════════════════════════ */
  const calc = useMemo(() => {
    const wb = n(wallet);
    const fee = n(feeRate) / 100;
    if (!wb) return null;

    const parsed = positions.map((p) => {
      const ep = n(p.entryPrice);
      const mg = n(p.margin);
      const lev = n(p.leverage);
      const notional = mg * lev;           // 진입 시 명목가 (고정)
      const qty = ep > 0 ? notional / ep : 0;
      const sign = p.dir === "long" ? 1 : -1;
      const pcp = n(coinPrices[p.coin] || ""); // 포지션별 현재가
      const liveNotional = pcp > 0 && qty > 0 ? qty * pcp : notional; // 실시간 포지션 크기
      let pnl = 0, roe = 0;
      if (pcp > 0 && qty > 0) {
        pnl = sign * (pcp - ep) * qty;
        roe = pct(pnl, mg);
      }
      return { ...p, ep, mg, lev, notional, liveNotional, qty, sign, pnl, roe, pcp };
    }).filter((p) => p.ep > 0 && p.mg > 0);

    // ── Account summary ──
    const totalPnL = parsed.reduce((a, p) => a + p.pnl, 0);
    const equity = wb + totalPnL;
    const totalMargin = parsed.reduce((a, p) => a + p.mg, 0);
    const lossOnlyPnL = parsed.reduce((a, p) => a + Math.min(p.pnl, 0), 0);
    const availEquity = wb + lossOnlyPnL;
    const freeMargin = availEquity - totalMargin;

    // 선택된 포지션 + 기준 현재가 (역산/청산가 계산용)
    const sel = selId ? parsed.find((p) => p.id === selId) || null : null;
    const cp = sel ? sel.pcp : (parsed.length > 0 ? parsed[0].pcp : 0);

    // ── 코인별 청산가에서 MMR 역산 ──
    // calcRefCoin의 청산가로 역산: 다른 코인 가격은 현재가 고정
    const calcRefCoin = sel ? sel.coin : (parsed[0]?.coin || "");
    const exLiq = getLiqPrice(calcRefCoin);
    let mmActual = null;
    let mmRate = null;
    let liqDistPct = null;

    if (exLiq > 0 && parsed.length > 0) {
      // equity at liq price: refCoin 포지션은 exLiq로 계산, 나머지는 현재가 고정
      mmActual = wb + parsed.reduce((a, p) => {
        const priceAtLiq = p.coin === calcRefCoin ? exLiq : p.pcp;
        return a + (priceAtLiq > 0 ? p.sign * (priceAtLiq - p.ep) * p.qty : 0);
      }, 0);

      // MMR = mmActual / totalNotionalAtLiqPrice
      const totalNotionalAtLiq = parsed.reduce((a, p) => {
        const priceAtLiq = p.coin === calcRefCoin ? exLiq : p.pcp;
        return a + p.qty * (priceAtLiq > 0 ? priceAtLiq : 0);
      }, 0);
      if (totalNotionalAtLiq > 0) {
        mmRate = mmActual / totalNotionalAtLiq;
      }

      if (cp > 0) {
        liqDistPct = ((cp - exLiq) / cp) * 100;
      }
    }

    // ── Helper: compute new liq price after position change ──
    // Given modified positions, solve for P where:
    //   wb + Σ sign_i × (P - ep_i) × qty_i = mmRate × Σ qty_i × P
    //
    // Expand:
    //   wb + P × Σ(sign_i × qty_i) - Σ(sign_i × ep_i × qty_i) = mmRate × P × Σ(qty_i)
    //   wb - Σ(sign_i × ep_i × qty_i) = P × [mmRate × Σ(qty_i) - Σ(sign_i × qty_i)]
    //   P = [wb - Σ(sign_i × ep_i × qty_i)] / [mmRate × Σ(qty_i) - Σ(sign_i × qty_i)]
    const solveLiq = (posArr, mmr) => {
      if (!mmr || mmr <= 0) return null;
      const sumSignQty = posArr.reduce((a, p) => a + p.sign * p.qty, 0);
      const sumSignEpQty = posArr.reduce((a, p) => a + p.sign * p.ep * p.qty, 0);
      const sumQty = posArr.reduce((a, p) => a + p.qty, 0);
      const denom = mmr * sumQty - sumSignQty;
      if (Math.abs(denom) < 1e-12) return null;
      const liq = (wb - sumSignEpQty) / denom;
      return liq > 0 ? liq : 0;
    };

    // ── 코인별 청산가 자동 계산 (MMR 역산 기반) ──
    // targetCoin의 가격만 움직이고, 나머지 코인은 현재가 고정 가정
    // equity(P) = wb + Σ pnl_i(P) = mmr × Σ notional_i(P)
    // targetCoin 포지션: pnl = sign*(P - ep)*qty, notional = qty*P
    // 다른 코인: pnl = sign*(pcp - ep)*qty (고정), notional = qty*pcp (고정)
    // => wb + Σ_target[sign*(P-ep)*qty] + Σ_other[pnl_fixed] = mmr × (Σ_target[qty*P] + Σ_other[notional_fixed])
    // => wb + P*Σ_t(sign*qty) - Σ_t(sign*ep*qty) + otherPnL = mmr*(P*Σ_t(qty) + otherNotional)
    // => P*(Σ_t(sign*qty) - mmr*Σ_t(qty)) = mmr*otherNotional - wb + Σ_t(sign*ep*qty) - otherPnL
    // => P = (mmr*otherNotional - wb + Σ_t(sign*ep*qty) - otherPnL) / (Σ_t(sign*qty) - mmr*Σ_t(qty))
    const solveLiqForCoin = (targetCoin, posArr, mmr) => {
      if (!mmr || mmr <= 0) return null;
      const targetPos = posArr.filter(p => p.coin === targetCoin);
      const otherPos = posArr.filter(p => p.coin !== targetCoin);
      if (targetPos.length === 0) return null;

      const sumTSignQty = targetPos.reduce((a, p) => a + p.sign * p.qty, 0);
      const sumTSignEpQty = targetPos.reduce((a, p) => a + p.sign * p.ep * p.qty, 0);
      const sumTQty = targetPos.reduce((a, p) => a + p.qty, 0);

      const otherPnL = otherPos.reduce((a, p) => {
        return a + (p.pcp > 0 ? p.sign * (p.pcp - p.ep) * p.qty : 0);
      }, 0);
      const otherNotional = otherPos.reduce((a, p) => {
        return a + p.qty * (p.pcp > 0 ? p.pcp : 0);
      }, 0);

      const numer = mmr * otherNotional - wb + sumTSignEpQty - otherPnL;
      const denom = sumTSignQty - mmr * sumTQty;
      if (Math.abs(denom) < 1e-12) return null;
      const liq = numer / denom;
      return liq > 0 ? liq : 0;
    };

    // 자동 계산된 코인별 청산가 맵
    const autoLiqPrices = {};
    if (mmRate && parsed.length > 0) {
      const allCoins = [...new Set(parsed.map(p => p.coin))];
      allCoins.forEach(coin => {
        // 이미 사용자가 직접 입력한 코인은 스킵 (기준 코인)
        if (coin === calcRefCoin) return;
        const coinPosCount = parsed.filter(p => p.coin === coin).length;
        if (coinPosCount === 0) return;
        // 해당 코인의 현재가가 있어야 계산 가능
        const coinCp = n(coinPrices[coin] || "");
        if (coinCp <= 0) return;
        const liq = solveLiqForCoin(coin, parsed, mmRate);
        if (liq != null && liq > 0) {
          autoLiqPrices[coin] = liq;
        }
      });
    }

    // ── Build DCA result (sim mode) ──
    let dcaResult = null;
    if (sel && dcaMode === "sim") {
      const dcaList = dcaEntries
        .filter((e) => n(e.price) > 0 && n(e.margin) > 0)
        .map((e) => {
          const price = n(e.price);
          const rawMargin = n(e.margin);
          // DCA 추가 마진: fromInput으로 정확한 수수료 차감
          const conv = fromInput(rawMargin, price, sel.lev, fee, sel.dir, sel.coin);
          if (!conv) return null;
          return { price, rawMargin, margin: conv.margin, feeDeduct: conv.openCost + conv.closeCost, notional: conv.size, qty: conv.qty };
        }).filter(Boolean);

      if (dcaList.length > 0) {
        const addTotalNotional = dcaList.reduce((a, d) => a + d.notional, 0);
        const addTotalQty = dcaList.reduce((a, d) => a + d.qty, 0);
        const addTotalMargin = dcaList.reduce((a, d) => a + d.margin, 0);

        const newNotional = sel.notional + addTotalNotional;
        const newQty = sel.qty + addTotalQty;
        const newAvg = newNotional / newQty;
        const newMargin = sel.mg + addTotalMargin;

        let afterPnL = 0, afterROE = 0;
        if (cp > 0) {
          afterPnL = sel.sign * (cp - newAvg) * newQty;
          afterROE = pct(afterPnL, newMargin);
        }

        // New liq price using exchange-derived MMR
        const afterParsed = parsed.map((p) =>
          p.id === sel.id ? { ...p, ep: newAvg, mg: newMargin, notional: newNotional, qty: newQty } : p
        );
        const afterLiq = mmRate ? solveLiq(afterParsed, mmRate) : null;

        let afterLiqDist = null;
        if (afterLiq != null && cp > 0) {
          afterLiqDist = ((cp - afterLiq) / cp) * 100;
        }

        // Breakeven (대수적 해: 진입+청산 수수료 반영)
        const breakeven = sel.dir === "long"
          ? newAvg * (1 + fee) / (1 - fee)
          : newAvg * (1 - fee) / (1 + fee);
        const totalFee = Math.abs(breakeven - newAvg) * newQty;
        const moveNeeded = pct(breakeven - newAvg, newAvg);

        // Free margin after (Bybit: 손실만 반영)
        const afterTotalMargin = totalMargin + addTotalMargin;
        const afterLossPnL = parsed.reduce((a, p) => {
          const pnl = p.id === sel.id
            ? sel.sign * (cp > 0 ? (cp - newAvg) * newQty : 0)
            : p.pnl;
          return a + Math.min(pnl, 0);
        }, 0);
        const afterFreeMargin = (wb + afterLossPnL) - afterTotalMargin;

        const isLong = sel.dir === "long";
        const liqWorse = exLiq > 0 && afterLiq != null &&
          (isLong ? afterLiq > exLiq : afterLiq < exLiq);

        dcaResult = {
          dcaList, addTotalMargin,
          addTotalRawMargin: dcaList.reduce((a, d) => a + d.rawMargin, 0),
          addTotalFeeDeduct: dcaList.reduce((a, d) => a + d.feeDeduct, 0),
          before: { avg: sel.ep, margin: sel.mg, notional: sel.notional, qty: sel.qty, liq: exLiq || null, pnl: sel.pnl, roe: sel.roe, liqDist: liqDistPct },
          after: { avg: newAvg, margin: newMargin, notional: newNotional, qty: newQty, liq: afterLiq, pnl: afterPnL, roe: afterROE, liqDist: afterLiqDist },
          breakeven, moveNeeded, totalFee, feeRate: fee,
          afterFreeMargin, liqWorse,
          avgDelta: newAvg - sel.ep,
          avgDeltaPct: pct(newAvg - sel.ep, sel.ep),
          marginInsufficient: dcaList.reduce((a, d) => a + d.rawMargin, 0) > Math.max(freeMargin, 0),
        };
      }
    }

    // ── Reverse calculation mode ──
    let revResult = null;
    if (sel && dcaMode === "reverse") {
      const rp = n(revPrice);
      const rt = n(revTarget);
      if (rp > 0 && rt > 0) {
        const isLong = sel.dir === "long";
        const denom = 1 - rt / rp;
        const impossible = (isLong ? rp > rt : rp < rt) || Math.abs(denom) < 1e-10;

        if (impossible) {
          revResult = { impossible: true };
        } else {
          const addNotional = (rt * sel.qty - sel.notional) / denom;
          if (addNotional <= 0) {
            revResult = { impossible: true };
          } else {
            const addMargin = addNotional / sel.lev;
            const addQty = addNotional / rp;
            const newQty = sel.qty + addQty;
            const newNotional = sel.notional + addNotional;
            const newMargin = sel.mg + addMargin;
            const newAvg = rt;

            let afterPnL = 0, afterROE = 0;
            if (cp > 0) {
              afterPnL = sel.sign * (cp - newAvg) * newQty;
              afterROE = pct(afterPnL, newMargin);
            }

            const afterParsed = parsed.map((p) =>
              p.id === sel.id ? { ...p, ep: newAvg, mg: newMargin, notional: newNotional, qty: newQty } : p
            );
            const afterLiq = mmRate ? solveLiq(afterParsed, mmRate) : null;

            let afterLiqDist = null;
            if (afterLiq != null && cp > 0) {
              afterLiqDist = ((cp - afterLiq) / cp) * 100;
            }

            const breakeven = isLong
              ? newAvg * (1 + fee) / (1 - fee)
              : newAvg * (1 - fee) / (1 + fee);
            const totalFee = Math.abs(breakeven - newAvg) * newQty;
            const moveNeeded = pct(breakeven - newAvg, newAvg);

            const afterTotalMargin = totalMargin + addMargin;
            // Bybit 방식: 역산 후에도 손실만 반영
            const revAfterLossPnL = parsed.reduce((a, p) => {
              const pnl = p.id === sel.id
                ? sel.sign * (cp > 0 ? (cp - newAvg) * newQty : 0)
                : p.pnl;
              return a + Math.min(pnl, 0);
            }, 0);
            const afterFreeMargin = (wb + revAfterLossPnL) - afterTotalMargin;

            const liqWorse = exLiq > 0 && afterLiq != null &&
              (isLong ? afterLiq > exLiq : afterLiq < exLiq);

            let maxReachableAvg = null;
            if (addMargin > Math.max(freeMargin, 0) && freeMargin > 0) {
              const maxNotional = freeMargin * sel.lev;
              const maxQty = maxNotional / rp;
              maxReachableAvg = (sel.notional + maxNotional) / (sel.qty + maxQty);
            }

            // 수수료 포함 투입 필요 금액 역산
            const requiredInputMargin = fromDisplay(addMargin, rp, sel.lev, fee, sel.dir);
            const revFeeDeduct = requiredInputMargin - addMargin;

            revResult = {
              impossible: false,
              requiredMargin: addMargin,
              requiredInputMargin, revFeeDeduct,
              requiredNotional: addNotional, addQty,
              before: { avg: sel.ep, margin: sel.mg, notional: sel.notional, qty: sel.qty, liq: exLiq || null, pnl: sel.pnl, roe: sel.roe, liqDist: liqDistPct },
              after: { avg: newAvg, margin: newMargin, notional: newNotional, qty: newQty, liq: afterLiq, pnl: afterPnL, roe: afterROE, liqDist: afterLiqDist },
              breakeven, moveNeeded, totalFee, feeRate: fee,
              afterFreeMargin, liqWorse,
              marginInsufficient: addMargin > Math.max(freeMargin, 0),
              maxReachableAvg,
            };
          }
        }
      }
    }

    // ── Solve price for target available amount (Bybit 방식: 이분법) ──
    // Bybit에서 available(P) = wb + Σ min(pnl_i(P), 0) - totalMargin
    // min() 클리핑으로 비선형이므로 이분법 탐색 사용

    // 주어진 가격 P에서 Bybit 방식 freeMargin 계산
    // refCoin: P가 적용되는 코인. 나머지 코인은 현재가(pcp) 고정.
    const calcFreeMarginAt = (P, posArr, extraMargin = 0) => {
      const arr = posArr || parsed;
      const tMg = arr.reduce((a, p) => a + p.mg, 0) + extraMargin;
      const lossPnL = arr.reduce((a, p) => {
        const priceForP = p.coin === calcRefCoin ? P : p.pcp;
        const pnl = priceForP > 0 ? p.sign * (priceForP - p.ep) * p.qty : 0;
        return a + Math.min(pnl, 0);
      }, 0);
      return wb + lossPnL - tMg;
    };

    // ── 코인별 가격 변동 freeMargin 계산 (임의 코인 대응) ──
    const calcFreeMarginAtCoin = (P, coin) => {
      const tMg = parsed.reduce((a, p) => a + p.mg, 0);
      const lossPnL = parsed.reduce((a, p) => {
        const priceForP = p.coin === coin ? P : p.pcp;
        const pnl2 = priceForP > 0 ? p.sign * (priceForP - p.ep) * p.qty : 0;
        return a + Math.min(pnl2, 0);
      }, 0);
      return wb + lossPnL - tMg;
    };

    // ── 코인별 가격 변동 분석 ──
    const analyzeCoins = (target) => {
      const coins = [...new Set(parsed.map(p => p.coin))];
      return coins.map(coin => {
        const coinCp2 = parsed.find(p => p.coin === coin)?.pcp || 0;
        if (coinCp2 <= 0) return null;

        const coinPositions = parsed.filter(p => p.coin === coin);
        const hasLong = coinPositions.some(p => p.dir === "long");
        const hasShort = coinPositions.some(p => p.dir === "short");
        const isHedged = hasLong && hasShort;

        // bisect 양방향
        const bisectCoin = (lo, hi) => {
          const fLo = calcFreeMarginAtCoin(lo, coin);
          const fHi = calcFreeMarginAtCoin(hi, coin);
          if (fLo < target && fHi < target) return null;
          let a2 = lo, b2 = hi;
          if (calcFreeMarginAtCoin(a2, coin) >= target) [a2, b2] = [b2, a2];
          for (let i = 0; i < 80; i++) {
            const mid = (a2 + b2) / 2;
            if (calcFreeMarginAtCoin(mid, coin) < target) a2 = mid; else b2 = mid;
          }
          const result = (a2 + b2) / 2;
          return result > 0 ? result : null;
        };

        const upR = bisectCoin(coinCp2, coinCp2 * 200);
        const dnR = bisectCoin(0.001, coinCp2);
        let neededPrice2 = null;
        if (upR != null && dnR != null) {
          neededPrice2 = Math.abs(upR - coinCp2) < Math.abs(dnR - coinCp2) ? upR : dnR;
        } else {
          neededPrice2 = upR != null ? upR : dnR;
        }

        // maxGain 샘플링 + kink points
        let maxAvail2 = calcFreeMarginAtCoin(coinCp2, coin);
        let maxAvailPrice2 = coinCp2;
        const samples2 = 100;
        for (let i = 0; i <= samples2; i++) {
          const pUp = coinCp2 * (1 + (i / samples2) * 10);
          const fUp = calcFreeMarginAtCoin(pUp, coin);
          if (fUp > maxAvail2) { maxAvail2 = fUp; maxAvailPrice2 = pUp; }
          const pDn = coinCp2 * (1 - (i / samples2) * 0.99);
          if (pDn > 0) {
            const fDn = calcFreeMarginAtCoin(pDn, coin);
            if (fDn > maxAvail2) { maxAvail2 = fDn; maxAvailPrice2 = pDn; }
          }
        }
        coinPositions.forEach(p => {
          if (p.ep > 0) {
            [p.ep * 0.999, p.ep, p.ep * 1.001].forEach(kp => {
              const f2 = calcFreeMarginAtCoin(kp, coin);
              if (f2 > maxAvail2) { maxAvail2 = f2; maxAvailPrice2 = kp; }
            });
          }
        });

        const maxGain = maxAvail2 - freeMargin;

        return {
          coin, coinCp: coinCp2, isHedged, neededPrice: neededPrice2,
          changePct: neededPrice2 ? ((neededPrice2 - coinCp2) / coinCp2) * 100 : null,
          maxGain, maxAvail: maxAvail2, maxAvailPrice: maxAvailPrice2,
          maxChangePct: ((maxAvailPrice2 - coinCp2) / coinCp2) * 100,
          reason: isHedged && maxGain < 5
            ? "양방향 포지션 — 가격 효과 상쇄"
            : neededPrice2 ? "도달 가능" : maxGain < 1 ? "가격 변동 효과 미미" : null,
        };
      }).filter(Boolean);
    };

    const solvePriceForAvail = (target, posArr, extraMargin = 0) => {
      if (!cp || cp <= 0) return null;
      const cur = calcFreeMarginAt(cp, posArr, extraMargin);
      if (cur >= target) return cp; // 이미 충분

      // 양방향 포지션에서는 위/아래 어느 쪽으로 가도 available이 줄어들 수 있으므로
      // 양쪽 모두 탐색하여 해가 있는 방향을 찾음
      const bisect = (lo, hi) => {
        const fLo = calcFreeMarginAt(lo, posArr, extraMargin);
        const fHi = calcFreeMarginAt(hi, posArr, extraMargin);
        if (fLo < target && fHi < target) return null; // 범위 내 해 없음
        // fHi >= target 쪽으로 수렴
        let a = lo, b = hi;
        if (calcFreeMarginAt(a, posArr, extraMargin) >= target) {
          // a 쪽이 이미 충분 — a에서 target 미만이 되는 지점을 찾아야 함 (반전)
          [a, b] = [b, a];
        }
        // a: 부족, b: 충분
        for (let i = 0; i < 80; i++) {
          const mid = (a + b) / 2;
          if (calcFreeMarginAt(mid, posArr, extraMargin) < target) a = mid;
          else b = mid;
        }
        const result = (a + b) / 2;
        return result > 0 ? result : null;
      };

      const upResult = bisect(cp, cp * 200);
      const dnResult = bisect(0.001, cp);

      // 둘 다 해가 있으면 현재가에 더 가까운 쪽 반환
      if (upResult != null && dnResult != null) {
        return Math.abs(upResult - cp) < Math.abs(dnResult - cp) ? upResult : dnResult;
      }
      return upResult != null ? upResult : dnResult;
    };

    // Target available calc (목표 사용 가능 금액)
    let availCalc = null;
    const tgt = n(targetAvail);
    if (tgt > 0 && parsed.length > 0 && cp > 0) {
      const shortfallAmt = tgt - freeMargin; // 부족분

      // ── 부분 청산 후 강제청산가 시뮬레이션 헬퍼 ──
      const simLiqAfterClose = (targetPos, closePct) => {
        if (!mmRate || closePct <= 0) return null;
        const ratio = closePct / 100;
        const realizedPnL = targetPos.pnl * ratio;
        const closeFeeAmt = targetPos.qty * ratio * targetPos.pcp * fee;
        const wbAfter = wb + realizedPnL - closeFeeAmt;

        const simParsed = parsed.map(p =>
          p.id === targetPos.id
            ? { ...p, qty: p.qty * (1 - ratio), mg: p.mg * (1 - ratio) }
            : p
        ).filter(p => p.qty > 1e-10);

        if (simParsed.length === 0) return null;

        const sumSignQty = simParsed.reduce((a, p) => a + p.sign * p.qty, 0);
        const sumSignEpQty = simParsed.reduce((a, p) => a + p.sign * p.ep * p.qty, 0);
        const sumQty = simParsed.reduce((a, p) => a + p.qty, 0);
        const denom = mmRate * sumQty - sumSignQty;
        if (Math.abs(denom) < 1e-12) return null;
        const liq = (wbAfter - sumSignEpQty) / denom;
        return liq > 0 ? liq : null;
      };

      // ── 부분 청산 가이드 (모든 경우 계산) ──
      const closeGuide = parsed
        .filter(p => p.pcp > 0 && p.qty > 0)
        .map(p => {
          const closeFee1Pct = p.qty * 0.01 * p.pcp * fee;
          const pnl1Pct = p.pnl * 0.01;
          const margin1Pct = p.mg * 0.01;
          const isProfitable = p.pnl >= 0;

          let freed1Pct;
          if (p.pnl < 0) {
            freed1Pct = margin1Pct - closeFee1Pct;
          } else {
            freed1Pct = margin1Pct + pnl1Pct - closeFee1Pct;
          }

          const balChange1Pct = pnl1Pct - closeFee1Pct;

          const maxFreed = freed1Pct * 100;
          let neededPct = freed1Pct > 0 ? (shortfallAmt / freed1Pct) : null;
          if (neededPct !== null && neededPct > 100) neededPct = null;
          const neededPctClamped = neededPct !== null ? Math.ceil(neededPct * 10) / 10 : null;

          const balChangeNeeded = neededPctClamped !== null ? balChange1Pct * neededPctClamped : null;
          const balChangeMax = balChange1Pct * 100;

          const costRatio = (!isProfitable && freed1Pct > 0)
            ? Math.abs(balChange1Pct) / freed1Pct
            : 0;

          // ── 강제청산가 시뮬레이션 ──
          const simPct = neededPctClamped !== null ? neededPctClamped : 100;
          const newLiq = simLiqAfterClose(p, simPct);
          const curLiqDist = liqDistPct;
          let newLiqDist = null;
          let liqDistChange = null;
          if (newLiq != null && cp > 0) {
            newLiqDist = ((cp - newLiq) / cp) * 100;
            if (curLiqDist != null) {
              liqDistChange = Math.abs(newLiqDist) - Math.abs(curLiqDist);
            }
          }
          let liqSafetyTag = "unknown";
          if (liqDistChange != null) {
            if (liqDistChange >= -1) liqSafetyTag = "safe";
            else if (liqDistChange >= -5) liqSafetyTag = "caution";
            else liqSafetyTag = "danger";
          }

          return {
            id: p.id, coin: p.coin, dir: p.dir,
            dirKr: p.dir === "long" ? "롱" : "숏",
            margin: p.mg, pnl: p.pnl, pcp: p.pcp,
            isProfitable,
            freed1Pct, maxFreed,
            closeFee100: closeFee1Pct * 100,
            neededPct: neededPctClamped,
            balChange1Pct, balChangeNeeded, balChangeMax,
            costRatio,
            newLiq, newLiqDist, curLiqDist, liqDistChange, liqSafetyTag, simPct,
            effective: freed1Pct > 0,
          };
        })
        .filter(g => g.effective)
        // 정렬: 청산가 안전 등급 우선 → 비용 적은 순 → 확보 많은 순
        .sort((a, b) => {
          const tier = { safe: 0, unknown: 1, caution: 2, danger: 3 };
          const tierDiff = tier[a.liqSafetyTag] - tier[b.liqSafetyTag];
          if (tierDiff !== 0) return tierDiff;
          if (a.costRatio !== b.costRatio) return a.costRatio - b.costRatio;
          return b.freed1Pct - a.freed1Pct;
        });

      // 첫 번째 항목에 추천 표시
      if (closeGuide.length > 0) closeGuide[0].isRecommended = true;

      // 추가 입금 필요 금액 + 입금 후 청산가 시뮬레이션
      const depositNeeded = shortfallAmt > 0 ? shortfallAmt : 0;
      let depositLiq = null;
      let depositLiqDist = null;
      if (depositNeeded > 0 && mmRate && parsed.length > 0) {
        const wbAfterDeposit = wb + depositNeeded;
        const sumSignQty = parsed.reduce((a, p) => a + p.sign * p.qty, 0);
        const sumSignEpQty = parsed.reduce((a, p) => a + p.sign * p.ep * p.qty, 0);
        const sumQty = parsed.reduce((a, p) => a + p.qty, 0);
        const denom = mmRate * sumQty - sumSignQty;
        if (Math.abs(denom) > 1e-12) {
          const liq = (wbAfterDeposit - sumSignEpQty) / denom;
          if (liq > 0) {
            depositLiq = liq;
            if (cp > 0) depositLiqDist = ((cp - liq) / cp) * 100;
          }
        }
      }

      if (freeMargin >= tgt) {
        availCalc = { sufficient: true, closeGuide, depositNeeded: 0 };
      } else {
        // 코인별 가격 분석
        const coinAnalysis = analyzeCoins(tgt);
        const hedgeDetected = coinAnalysis.some(c => c.isHedged);
        const bestCoinSolution = coinAnalysis.find(c => c.neededPrice != null);

        const neededPrice = solvePriceForAvail(tgt);
        if (neededPrice != null) {
          const direction = neededPrice > cp ? "up" : "down";
          const changePct = ((neededPrice - cp) / cp) * 100;
          availCalc = { sufficient: false, neededPrice, direction, changePct, closeGuide, depositNeeded, depositLiq, depositLiqDist, coinAnalysis, hedgeDetected, bestCoinSolution };
        } else {
          // 최대 확보 가능 금액 탐색 (샘플링 + kink points)
          let maxAvail = freeMargin;
          let maxAvailPrice = cp;
          const samples = 200;
          for (let i = 0; i <= samples; i++) {
            const pUp = cp * (1 + (i / samples) * 10);
            const fUp = calcFreeMarginAt(pUp);
            if (fUp > maxAvail) { maxAvail = fUp; maxAvailPrice = pUp; }
            const pDn = cp * (1 - (i / samples) * 0.99);
            if (pDn > 0) {
              const fDn = calcFreeMarginAt(pDn);
              if (fDn > maxAvail) { maxAvail = fDn; maxAvailPrice = pDn; }
            }
          }
          // kink points: calcRefCoin 포지션들의 진입가 (freeMargin이 꺾이는 정확한 지점)
          parsed.forEach(p => {
            if (p.coin === calcRefCoin && p.ep > 0) {
              [p.ep * 0.999, p.ep, p.ep * 1.001].forEach(kp => {
                const fk = calcFreeMarginAt(kp);
                if (fk > maxAvail) { maxAvail = fk; maxAvailPrice = kp; }
              });
            }
          });

          // kink 보강 후 다시 해 탐색 (maxAvail이 tgt 이상이 되었을 수 있음)
          if (maxAvail >= tgt) {
            // 정확한 해를 bisect으로 다시 찾기
            availCalc = {
              sufficient: false, neededPrice: maxAvailPrice,
              direction: maxAvailPrice > cp ? "up" : "down",
              changePct: ((maxAvailPrice - cp) / cp) * 100,
              closeGuide, depositNeeded, depositLiq, depositLiqDist, coinAnalysis, hedgeDetected, bestCoinSolution,
            };
          } else {
            const shortfall = tgt - maxAvail;
            availCalc = {
              sufficient: false, impossible: true,
              maxAvail, maxAvailPrice, shortfall,
              maxChangePct: ((maxAvailPrice - cp) / cp) * 100,
              closeGuide, depositNeeded, depositLiq, depositLiqDist, coinAnalysis, hedgeDetected, bestCoinSolution,
            };
          }
        }
      }
    }

    // ── Shortfall price for DCA result ──
    const computeShortfallPrice = (addTotalMargin) => {
      if (freeMargin >= addTotalMargin) return null;
      const shortfall = addTotalMargin - Math.max(freeMargin, 0);
      // Need freeMargin to increase by shortfall
      // available(P) = wb + P*sumA - sumB - totalMargin = current freeMargin + delta
      // We need available(P) >= addTotalMargin
      const neededPrice = solvePriceForAvail(addTotalMargin);
      if (neededPrice != null && cp > 0) {
        return { price: neededPrice, shortfall, changePct: ((neededPrice - cp) / cp) * 100 };
      }
      return { shortfall, impossible: true };
    };

    // Attach shortfallPrice to dcaResult
    if (dcaResult && dcaResult.marginInsufficient) {
      dcaResult.shortfallInfo = computeShortfallPrice(dcaResult.addTotalMargin);
    }
    // Attach shortfallPrice to revResult
    if (revResult && !revResult.impossible && revResult.marginInsufficient) {
      revResult.shortfallInfo = computeShortfallPrice(revResult.requiredMargin);
    }

    // ── Close (손절) simulation ──
    let closeResult = null;
    if (sel && dcaMode === "close") {
      const ratio = n(closeRatio) / 100;
      const cp2 = n(closePrice) || cp; // default to current price
      if (ratio > 0 && ratio <= 1 && cp2 > 0) {
        const closedQty = sel.qty * ratio;
        const closedNotional = sel.notional * ratio;
        const closedMargin = sel.mg * ratio;

        // Realized PnL from closing
        const realizedPnL = sel.sign * (cp2 - sel.ep) * closedQty;
        // Close fee (one-way since opening fee already paid)
        const closeFee = closedQty * cp2 * fee;

        // Remaining position
        const remQty = sel.qty - closedQty;
        const remNotional = sel.notional - closedNotional;
        const remMargin = sel.mg - closedMargin;

        // New wallet balance: old wallet + realizedPnL - closeFee
        // In cross margin, realized PnL is added to wallet, margin is released
        const newWallet = wb + realizedPnL - closeFee;

        // Remaining unrealized PnL (all positions, with sel reduced)
        const remParsed = parsed.map((p) =>
          p.id === sel.id
            ? { ...p, qty: remQty, notional: remNotional, mg: remMargin }
            : p
        ).filter((p) => p.qty > 0);

        const remTotalPnL = remParsed.reduce((a, p) => a + p.sign * (cp - p.ep) * p.qty, 0);
        const remEquity = newWallet + remTotalPnL;
        const remTotalMargin = remParsed.reduce((a, p) => a + p.mg, 0);
        // Bybit 방식: 손실만 반영
        const remLossPnL = remParsed.reduce((a, p) => {
          const pnl = p.sign * (cp - p.ep) * p.qty;
          return a + Math.min(pnl, 0);
        }, 0);
        const remFreeMargin = (newWallet + remLossPnL) - remTotalMargin;

        // New liq price
        const remLiq = mmRate ? solveLiq(remParsed, mmRate) : null;
        let remLiqDist = null;
        if (remLiq != null && cp > 0) {
          remLiqDist = ((cp - remLiq) / cp) * 100;
        }

        // Remaining position PnL
        let remPosPnL = 0, remPosROE = 0;
        if (remQty > 0 && cp > 0) {
          remPosPnL = sel.sign * (cp - sel.ep) * remQty;
          remPosROE = remMargin > 0 ? pct(remPosPnL, remMargin) : 0;
        }

        // "손절 후 물타기" scenario: use all freed margin at a hypothetical DCA price
        // We'll compute for the DCA price entered in sim mode (first entry), or skip
        let closeAndDCA = null;
        if (remFreeMargin > 0 && remQty > 0) {
          // Use the first DCA entry price if available, otherwise skip
          const dcaPrice = dcaEntries.length > 0 ? n(dcaEntries[0].price) : 0;
          if (dcaPrice > 0) {
            const dcaRawMargin = remFreeMargin;
            const dcaConv = fromInput(dcaRawMargin, dcaPrice, sel.lev, fee, sel.dir, sel.coin);
            const dcaMargin = dcaConv ? dcaConv.margin : 0;
            const dcaNotional = dcaConv ? dcaConv.size : 0;
            const dcaQty = dcaConv ? dcaConv.qty : 0;
            const newQty2 = remQty + dcaQty;
            const newNotional2 = remNotional + dcaNotional;
            const newAvg2 = newNotional2 / newQty2;
            const newMargin2 = remMargin + dcaMargin;

            const afterPnL2 = sel.sign * (cp - newAvg2) * newQty2;
            const afterROE2 = newMargin2 > 0 ? pct(afterPnL2, newMargin2) : 0;

            const breakeven2 = sel.dir === "long"
              ? newAvg2 * (1 + fee) / (1 - fee)
              : newAvg2 * (1 - fee) / (1 + fee);

            // New liq after close + DCA
            const cdParsed = remParsed.map((p) =>
              p.id === sel.id
                ? { ...p, ep: newAvg2, qty: newQty2, notional: newNotional2, mg: newMargin2 }
                : p
            );
            const cdLiq = mmRate ? solveLiq(cdParsed, mmRate) : null;

            closeAndDCA = {
              dcaPrice, dcaMargin, dcaQty,
              newAvg: newAvg2, newQty: newQty2, newMargin: newMargin2,
              pnl: afterPnL2, roe: afterROE2,
              breakeven: breakeven2,
              liq: cdLiq,
            };
          }
        }

        closeResult = {
          ratio, closePrice: cp2, closedQty, closedMargin,
          realizedPnL, closeFee,
          newWallet,
          remaining: {
            qty: remQty, notional: remNotional, margin: remMargin,
            avg: sel.ep, // avg doesn't change on partial close
            pnl: remPosPnL, roe: remPosROE,
          },
          remEquity, remTotalMargin, remFreeMargin,
          remLiq, remLiqDist,
          liqBefore: exLiq || null,
          liqDistBefore: liqDistPct,
          closeAndDCA,
        };
      }
    }

    // ── Hedge simulation ──
    let hedgeResult = null;
    const hedgePos = hedgeId ? parsed.find(p => p.id === hedgeId) : null;
    if (hedgePos) {
      const hEntry = n(hedgeEntry);
      const hInput = n(hedgeMargin);
      const hLev = n(hedgeLev) || hedgePos.lev;
      const hedgeDir = hedgePos.dir === "long" ? "short" : "long";
      const hedgeSign = hedgeDir === "long" ? 1 : -1;
      const hCp = hedgePos.pcp; // 해당 코인 현재가

      if (hEntry > 0 && hInput > 0 && hLev > 0) {
        const conv = fromInput(hInput, hEntry, hLev, fee, hedgeDir, hedgePos.coin);
        if (conv) {
          const virtualPos = {
            id: "hedge-virtual", dir: hedgeDir, sign: hedgeSign, coin: hedgePos.coin,
            ep: hEntry, mg: conv.margin, qty: conv.qty,
            notional: conv.size, lev: hLev, pcp: hCp,
          };
          const simParsed = [...parsed, virtualPos];

          // 새 강청가
          const newLiq = mmRate ? solveLiq(simParsed, mmRate) : null;

          const liqBefore2 = exLiq || null;
          const liqAfter = newLiq;
          const hIsLong = hedgePos.dir === "long";
          let liqImproved = null;
          if (liqBefore2 && liqAfter) {
            liqImproved = hIsLong ? liqAfter < liqBefore2 : liqAfter > liqBefore2;
          }
          let liqDistAfter = null;
          if (liqAfter != null && hCp > 0) {
            liqDistAfter = ((hCp - liqAfter) / hCp) * 100;
          }

          // 동시 청산 PnL
          const origPnLAt = (P) => hedgePos.sign * (P - hedgePos.ep) * hedgePos.qty;
          const hedgePnLAt = (P) => hedgeSign * (P - hEntry) * conv.qty;
          const hCloseFeeAt = (P) => (hedgePos.qty + conv.qty) * P * fee;
          const hEntryFees = conv.openCost;
          const netAt = (P) => origPnLAt(P) + hedgePnLAt(P) - hCloseFeeAt(P) - hEntryFees;

          // 본전가 (청산 수수료만)
          const coefP = hedgePos.sign * hedgePos.qty + hedgeSign * conv.qty - fee * (hedgePos.qty + conv.qty);
          const constTerm = hedgePos.sign * hedgePos.ep * hedgePos.qty + hedgeSign * hEntry * conv.qty;
          let breakevenClose2 = null;
          if (Math.abs(coefP) > 1e-12) { const be = constTerm / coefP; if (be > 0) breakevenClose2 = be; }
          // 본전가 (전체 수수료)
          let breakevenAll = null;
          if (Math.abs(coefP) > 1e-12) { const be = (constTerm + hEntryFees) / coefP; if (be > 0) breakevenAll = be; }

          // 가용 마진 변화
          const simTotalMargin = totalMargin + conv.margin;
          const simLossPnL = simParsed.reduce((a, p) => {
            const pp = p.pcp > 0 ? p.pcp : (p.coin === hedgePos.coin ? hCp : 0);
            const pnl2 = pp > 0 ? p.sign * (pp - p.ep) * p.qty : 0;
            return a + Math.min(pnl2, 0);
          }, 0);
          const simFreeMargin = (wb + simLossPnL) - simTotalMargin;

          // 시나리오
          const hScenarios = [];
          [-10, -5, -3, -1, 0, 1, 3, 5, 10].forEach(pv => {
            const P = hCp > 0 ? hCp * (1 + pv / 100) : 0;
            if (P <= 0) return;
            hScenarios.push({
              label: pv === 0 ? "현재가" : `${pv > 0 ? "+" : ""}${pv}%`,
              price: P, origPnL: origPnLAt(P), hedgePnL: hedgePnLAt(P),
              combined: origPnLAt(P) + hedgePnLAt(P),
              closeFee: hCloseFeeAt(P), net: netAt(P), isCurrent: pv === 0,
            });
          });
          if (breakevenAll && hCp > 0) {
            hScenarios.push({
              label: "본전", price: breakevenAll,
              origPnL: origPnLAt(breakevenAll), hedgePnL: hedgePnLAt(breakevenAll),
              combined: origPnLAt(breakevenAll) + hedgePnLAt(breakevenAll),
              closeFee: hCloseFeeAt(breakevenAll), net: 0, isSpecial: true,
            });
          }
          hScenarios.sort((a, b) => a.price - b.price);

          hedgeResult = {
            conv, hedgeDir, hedgeSign, hEntry, hLev, hCp,
            hedgePos, virtualPos,
            liqBefore: liqBefore2, liqAfter, liqImproved,
            liqDistBefore: liqDistPct,
            liqDistAfter,
            liqChange: liqBefore2 && liqAfter ? ((liqAfter - liqBefore2) / liqBefore2) * 100 : null,
            breakevenClose: breakevenClose2, breakevenAll,
            beAllDist: breakevenAll && hCp > 0 ? ((breakevenAll - hCp) / hCp) * 100 : null,
            currentOrigPnL: hCp > 0 ? origPnLAt(hCp) : 0,
            currentHedgePnL: hCp > 0 ? hedgePnLAt(hCp) : 0,
            currentCloseFee: hCp > 0 ? hCloseFeeAt(hCp) : 0,
            currentNet: hCp > 0 ? netAt(hCp) : 0,
            entryFees: hEntryFees,
            hedgeMarginDisplay: conv.margin,
            hedgeFeeDeduct: conv.openCost + conv.closeCost,
            afterTotalMargin: simTotalMargin,
            afterFreeMargin: simFreeMargin,
            marginInsufficient: hInput > Math.max(freeMargin, 0),
            scenarios: hScenarios,
          };
        }
      }
    }

    // ── Split optimization ──
    let splitResult = null;
    if (sel && dcaMode === "sim" && splitMode) {
      const sTotal = n(splitTotal);
      const prices = splitPrices.map((p) => n(p)).filter((p) => p > 0);
      const sCount = prices.length;

      if (sTotal > 0 && sCount >= 2) {
        const isLong = sel.dir === "long";

        // Sort prices: for long, high→low (closer to current first); for short, low→high
        const sorted = [...prices].sort((a, b) => isLong ? b - a : a - b);

        const strategies = [
          {
            name: "균등",
            desc: "동일 금액",
            weights: sorted.map(() => 1),
          },
          {
            name: "앞에 몰기",
            desc: "현재가 근처에 많이",
            weights: sorted.map((_, i) => sCount - i),
          },
          {
            name: "뒤에 몰기",
            desc: "유리한 가격에 많이",
            weights: sorted.map((_, i) => i + 1),
          },
          {
            name: "마틴게일",
            desc: "2배씩 증가",
            weights: sorted.map((_, i) => Math.pow(2, i)),
          },
        ];

        const results = strategies.map((strat) => {
          const totalWeight = strat.weights.reduce((a, w) => a + w, 0);
          const entries = sorted.map((price, i) => {
            const rawMargin = sTotal * strat.weights[i] / totalWeight;
            const conv = fromInput(rawMargin, price, sel.lev, fee, sel.dir, sel.coin);
            if (!conv) return { price, rawMargin, margin: 0, feeDeduct: 0, notional: 0, qty: 0 };
            return { price, rawMargin, margin: conv.margin, feeDeduct: conv.openCost + conv.closeCost, notional: conv.size, qty: conv.qty };
          });

          const addNotional = entries.reduce((a, e) => a + e.notional, 0);
          const addQty = entries.reduce((a, e) => a + e.qty, 0);
          const newNotional = sel.notional + addNotional;
          const newQty = sel.qty + addQty;
          const newAvg = newNotional / newQty;
          const newMargin = sel.mg + entries.reduce((a, e) => a + e.margin, 0);

          const afterParsed = parsed.map((p) =>
            p.id === sel.id ? { ...p, ep: newAvg, mg: newMargin, notional: newNotional, qty: newQty } : p
          );
          const afterLiq = mmRate ? solveLiq(afterParsed, mmRate) : null;

          const breakeven = isLong
            ? newAvg * (1 + fee) / (1 - fee)
            : newAvg * (1 - fee) / (1 + fee);

          let afterPnL = 0, afterROE = 0;
          if (cp > 0) {
            afterPnL = sel.sign * (cp - newAvg) * newQty;
            afterROE = pct(afterPnL, newMargin);
          }

          return {
            name: strat.name, desc: strat.desc, entries,
            newAvg, newQty, newMargin, newNotional,
            afterLiq, breakeven, afterPnL, afterROE,
          };
        });

        let bestIdx = 0;
        results.forEach((r, i) => {
          if (isLong ? r.newAvg < results[bestIdx].newAvg : r.newAvg > results[bestIdx].newAvg) {
            bestIdx = i;
          }
        });

        splitResult = {
          prices: sorted, results, bestIdx,
          totalMargin: sTotal,
          marginInsufficient: sTotal > Math.max(freeMargin, 0),
        };
      }
    }

    // ── Pyramiding (불타기) calculation ──
    let pyraResult = null;
    let pyraRevResult = null;
    const pyraLocked = pyraMode ? parsed.find((p) => p.id === pyraLockedId) : null;
    const pyraCounter = pyraMode && pyraCounterId ? parsed.find((p) => p.id === pyraCounterId) : null;

    if (pyraCounter && pyraMode) {
      // counter = winning position (불타기 대상), locked = losing position (물린)
      // pyraEntries add to the counter position's direction
      const counterDir = pyraCounter.dir;
      const counterSign = pyraCounter.sign;
      const lockedSign = pyraLocked ? pyraLocked.sign : 0;
      const lockedEp = pyraLocked ? pyraLocked.ep : 0;
      const lockedQty = pyraLocked ? pyraLocked.qty : 0;
      const lockedMg = pyraLocked ? pyraLocked.mg : 0;
      const lockedDir = pyraLocked ? pyraLocked.dir : (counterDir === "long" ? "short" : "long");
      const hasLocked = pyraLocked != null;

      if (pyraSubMode === "sim") {
        // Parse pyramiding entries as new counter-direction entries
        const pyraList = pyraEntries
          .filter((e) => n(e.price) > 0 && n(e.margin) > 0)
          .map((e) => {
            const price = n(e.price);
            const rawMargin = n(e.margin);
            const conv = fromInput(rawMargin, price, pyraCounter.lev, fee, pyraCounter.dir, pyraCounter.coin);
            if (!conv) return null;
            return { price, rawMargin, margin: conv.margin, feeDeduct: conv.openCost + conv.closeCost, notional: conv.size, qty: conv.qty };
          }).filter(Boolean);

        if (pyraList.length > 0 || pyraCounter) {
          // Existing counter position values
          const existCounterNotional = pyraCounter ? pyraCounter.notional : 0;
          const existCounterQty = pyraCounter ? pyraCounter.qty : 0;
          const existCounterMargin = pyraCounter ? pyraCounter.mg : 0;
          const existCounterEp = pyraCounter ? pyraCounter.ep : 0;

          // New entries from pyramiding
          const addTotalNotional = pyraList.reduce((a, d) => a + d.notional, 0);
          const addTotalQty = pyraList.reduce((a, d) => a + d.qty, 0);
          const addTotalMargin = pyraList.reduce((a, d) => a + d.margin, 0);

          // Combined counter position
          const totalCounterNotional = existCounterNotional + addTotalNotional;
          const totalCounterQty = existCounterQty + addTotalQty;
          const totalCounterMargin = existCounterMargin + addTotalMargin;
          const totalCounterAvg = totalCounterQty > 0 ? totalCounterNotional / totalCounterQty : 0;

          // Locked position PnL at various prices
          const lockedPnLAt = (p) => lockedSign * (p - lockedEp) * lockedQty;
          const counterPnLAt = (p) => totalCounterQty > 0 ? counterSign * (p - totalCounterAvg) * totalCounterQty : 0;

          // Close fees for simultaneous close at price P
          const closeFeeAt = (p) => {
            const lockedFee = lockedQty * p * fee;
            const counterFee = totalCounterQty * p * fee;
            return lockedFee + counterFee;
          };

          // Combined net PnL at price P
          const netPnLAt = (p) => lockedPnLAt(p) + counterPnLAt(p) - closeFeeAt(p);

          // Solve reversal price: lockedPnL + counterPnL - fees = 0
          // sign_a*(P-ep_a)*qty_a + sign_b*(P-ep_b)*qty_b - fee*(qty_a+qty_b)*P = 0
          // P * [sign_a*qty_a + sign_b*qty_b - fee*(qty_a+qty_b)] = sign_a*ep_a*qty_a + sign_b*ep_b*qty_b
          let reversalPrice = null;
          if (totalCounterQty > 0) {
            const coefP = lockedSign * lockedQty + counterSign * totalCounterQty - fee * (lockedQty + totalCounterQty);
            const constTerm = lockedSign * lockedEp * lockedQty + counterSign * totalCounterAvg * totalCounterQty;
            if (Math.abs(coefP) > 1e-12) {
              const rp = constTerm / coefP;
              if (rp > 0) reversalPrice = rp;
            }
          }

          // Distance from current price to reversal
          let reversalDist = null;
          if (reversalPrice != null && cp > 0) {
            reversalDist = ((reversalPrice - cp) / cp) * 100;
          }

          // Combined PnL at current price
          const combinedPnL = cp > 0 ? lockedPnLAt(cp) + counterPnLAt(cp) : 0;
          const simultaneousClose = cp > 0 ? netPnLAt(cp) : 0;

          // New liq price after adding counter entries
          let newLiqPrice = null;
          let newLiqDist = null;
          if (mmRate && pyraList.length > 0) {
            const afterParsed = [...parsed];
            if (pyraCounter) {
              // Update existing counter position
              const idx = afterParsed.findIndex((p) => p.id === pyraCounterId);
              if (idx >= 0) {
                afterParsed[idx] = {
                  ...afterParsed[idx],
                  ep: totalCounterAvg, mg: totalCounterMargin,
                  notional: totalCounterNotional, qty: totalCounterQty,
                };
              }
            } else {
              // Add new virtual counter position
              afterParsed.push({
                id: "pyra-virtual", dir: counterDir, sign: counterSign,
                ep: totalCounterAvg, mg: totalCounterMargin,
                notional: totalCounterNotional, qty: totalCounterQty,
                lev: pyraCounter.lev,
              });
            }
            newLiqPrice = solveLiq(afterParsed, mmRate);
            if (newLiqPrice != null && cp > 0) {
              newLiqDist = ((cp - newLiqPrice) / cp) * 100;
            }
          }

          // Stage-by-stage analysis
          const stages = [];
          let cumNotional = existCounterNotional;
          let cumQty = existCounterQty;
          let cumMargin = existCounterMargin;

          // If existing counter, add as stage 0
          if (pyraCounter) {
            stages.push({
              step: 0, label: "기존 포지션",
              margin: existCounterMargin, cumMargin: existCounterMargin,
              avg: existCounterEp,
              reversalPrice: (() => {
                const coef = lockedSign * lockedQty + counterSign * existCounterQty - fee * (lockedQty + existCounterQty);
                const ct = lockedSign * lockedEp * lockedQty + counterSign * existCounterEp * existCounterQty;
                if (Math.abs(coef) > 1e-12) { const r = ct / coef; return r > 0 ? r : null; }
                return null;
              })(),
              liqPrice: exLiq || null,
              liqDist: liqDistPct,
            });
          }

          pyraList.forEach((entry, i) => {
            cumNotional += entry.notional;
            cumQty += entry.qty;
            cumMargin += entry.margin;
            const stepAvg = cumNotional / cumQty;

            // Reversal price at this stage
            const coef = lockedSign * lockedQty + counterSign * cumQty - fee * (lockedQty + cumQty);
            const ct = lockedSign * lockedEp * lockedQty + counterSign * stepAvg * cumQty;
            let stepReversal = null;
            if (Math.abs(coef) > 1e-12) { const r = ct / coef; if (r > 0) stepReversal = r; }

            // Liq price at this stage
            let stepLiq = null, stepLiqDist = null;
            if (mmRate) {
              const stepParsed = [...parsed];
              if (pyraCounter) {
                const idx = stepParsed.findIndex((p) => p.id === pyraCounterId);
                if (idx >= 0) {
                  stepParsed[idx] = { ...stepParsed[idx], ep: stepAvg, mg: cumMargin, notional: cumNotional, qty: cumQty };
                }
              } else {
                // For stages, add virtual
                stepParsed.push({
                  id: "pyra-virtual", dir: counterDir, sign: counterSign,
                  ep: stepAvg, mg: cumMargin, notional: cumNotional, qty: cumQty, lev: pyraCounter.lev,
                });
              }
              stepLiq = solveLiq(stepParsed, mmRate);
              if (stepLiq != null && cp > 0) stepLiqDist = ((cp - stepLiq) / cp) * 100;
            }

            stages.push({
              step: i + 1,
              label: pyraCounter && i === 0 ? "불타기 1" : `불타기 ${pyraCounter ? i + 1 : i + 1}`,
              margin: entry.margin, cumMargin,
              avg: stepAvg,
              reversalPrice: stepReversal,
              liqPrice: stepLiq, liqDist: stepLiqDist,
            });
          });

          // Scenarios table: at various prices
          const scenarios = [];
          if (cp > 0 && totalCounterQty > 0) {
            const pricePoints = [];
            // Add reversal price
            if (reversalPrice) pricePoints.push({ label: "역전가", price: reversalPrice });
            // Add current price
            pricePoints.push({ label: "현재가", price: cp });
            // Add percentage offsets from current
            const offsets = pyraCounter.dir === "short"
              ? [-1, -3, -5, -10] // price drops (short gaining, locked long losing)
              : [1, 3, 5, 10];    // price rises (long gaining, locked short losing)
            offsets.forEach((pctOff) => {
              pricePoints.push({ label: `${pctOff > 0 ? "+" : ""}${pctOff}%`, price: cp * (1 + pctOff / 100) });
            });
            // Sort by price
            pricePoints.sort((a, b) => a.price - b.price);

            pricePoints.forEach(({ label, price }) => {
              scenarios.push({
                label, price,
                lockedPnL: lockedPnLAt(price),
                counterPnL: counterPnLAt(price),
                combined: lockedPnLAt(price) + counterPnLAt(price),
                fee: closeFeeAt(price),
                net: netPnLAt(price),
              });
            });
          }

          // Warnings
          const warnings = [];
          if (newLiqDist != null && Math.abs(newLiqDist) < 15) {
            warnings.push({ type: "danger", message: `청산 위험 — 여유 ${fmt(Math.abs(newLiqDist))}% (15% 미만)` });
          }
          if (addTotalMargin > Math.max(freeMargin, 0)) {
            warnings.push({ type: "danger", message: `사용 가능(${fmt(freeMargin)}) < 필요 마진(${fmt(addTotalMargin)}) USDT` });
          }

          // Info items
          const infos = [];
          const lockedMargin = lockedMg;
          if (totalCounterMargin > lockedMargin) {
            infos.push(`반대 포지션 누적(${fmt(totalCounterMargin)})이 물린 포지션(${fmt(lockedMargin)})보다 큽니다`);
          }
          if (totalCounterMargin > lockedMargin * 2) {
            infos.push(`반대 포지션이 물린 포지션의 ${fmt(totalCounterMargin / lockedMargin, 1)}배입니다`);
          }

          // 청산 시나리오 3가지
          const closeScenarios = cp > 0 ? {
            both: {
              pnl: lockedPnLAt(cp) + counterPnLAt(cp),
              fee: closeFeeAt(cp),
              net: netPnLAt(cp),
              label: "양쪽 동시 청산",
            },
            lockedOnly: {
              pnl: lockedPnLAt(cp),
              fee: lockedQty * cp * fee,
              net: lockedPnLAt(cp) - lockedQty * cp * fee,
              label: "물린 쪽만 청산",
            },
            counterOnly: {
              pnl: counterPnLAt(cp),
              fee: totalCounterQty * cp * fee,
              net: counterPnLAt(cp) - totalCounterQty * cp * fee,
              label: "불타기 쪽만 청산",
            },
          } : null;

          // 역전가 프로그레스
          let reversalProgress = null;
          if (reversalPrice && cp > 0 && hasLocked) {
            // 물린 포지션 진입가 → 역전가 구간에서 현재가의 위치
            const start = lockedEp;
            const end = reversalPrice;
            const range = Math.abs(end - start);
            if (range > 0) {
              const dist = Math.abs(cp - start);
              reversalProgress = Math.min(Math.max(dist / range, 0), 1);
              // 방향 보정: 역전가 쪽으로 가고 있는지 확인
              if (counterSign > 0) {
                // counter가 롱이면 가격이 올라야 역전 → cp > start일 때 진행 중
                reversalProgress = cp > start ? Math.min((cp - start) / (end - start), 1) : 0;
              } else {
                // counter가 숏이면 가격이 내려야 역전 → cp < start일 때 진행 중
                reversalProgress = cp < start ? Math.min((start - cp) / (start - end), 1) : 0;
              }
              reversalProgress = Math.max(Math.min(reversalProgress, 1), 0);
            }
          }

          // 불타기 vs 물타기 비교 (같은 금액을 물린 포지션에 DCA할 때)
          let dcaComparison = null;
          if (addTotalMargin > 0 && hasLocked && cp > 0) {
            // 물타기: 물린 포지션의 대표 가격(첫 번째 pyraEntry 가격)으로 DCA
            const dcaPrice = pyraList.length > 0 ? pyraList[0].price : cp;
            const dcaNotional = addTotalMargin * (pyraLocked?.lev || pyraCounter.lev);
            const dcaQty = dcaPrice > 0 ? dcaNotional / dcaPrice : 0;
            const dcaNewNotional = (pyraLocked ? pyraLocked.notional : 0) + dcaNotional;
            const dcaNewQty = lockedQty + dcaQty;
            const dcaNewAvg = dcaNewQty > 0 ? dcaNewNotional / dcaNewQty : 0;
            const dcaNewMargin = lockedMg + addTotalMargin;

            // DCA 후 본전가 (수수료 포함)
            const dcaBreakeven = lockedSign > 0
              ? dcaNewAvg * (1 + fee) / (1 - fee)
              : dcaNewAvg * (1 - fee) / (1 + fee);

            // DCA 후 청산가
            let dcaLiq = null;
            if (mmRate) {
              const dcaParsed = [...parsed];
              const idx = dcaParsed.findIndex((p) => p.id === pyraLockedId);
              if (idx >= 0) {
                dcaParsed[idx] = { ...dcaParsed[idx], ep: dcaNewAvg, mg: dcaNewMargin, notional: dcaNewNotional, qty: dcaNewQty };
              }
              dcaLiq = solveLiq(dcaParsed, mmRate);
            }

            dcaComparison = {
              dcaAvg: dcaNewAvg, dcaBreakeven, dcaLiq, dcaMargin: dcaNewMargin,
              pyraReversal: reversalPrice, pyraLiq: newLiqPrice,
              dcaPrice,
            };
          }

          pyraResult = {
            locked: pyraLocked, counterDir, counterSign,
            existingCounter: pyraCounter,
            pyraList, addTotalMargin,
            counter: {
              avg: totalCounterAvg, qty: totalCounterQty,
              margin: totalCounterMargin, notional: totalCounterNotional,
            },
            reversalPrice, reversalDist, reversalProgress,
            combinedPnL, simultaneousClose,
            closeScenarios,
            newLiqPrice, newLiqDist,
            liqBefore: exLiq || null, liqDistBefore: liqDistPct,
            stages, scenarios, warnings, infos,
            marginInsufficient: addTotalMargin > Math.max(freeMargin, 0),
            dcaComparison,
          };
        }
      }

      // ── Pyramiding reverse calc: target reversal price → needed margin ──
      if (pyraSubMode === "reverse") {
        const prp = n(pyraRevPrice);
        const prt = n(pyraRevTarget);

        if (prp > 0 && prt > 0 && hasLocked) {
          const rCounterSign = pyraCounter.sign;
          const existCounterQty = pyraCounter.qty;
          const existCounterNotional = pyraCounter.notional;
          const existCounterMargin = pyraCounter.mg;
          const existCounterAvg = pyraCounter.ep;

          // Solve: at target reversal price T, net PnL = 0
          // locked_pnl(T) + counter_pnl(T) - fees(T) = 0
          // sign_a*(T-ep_a)*qty_a + sign_b*(T - newAvg)*(existQty + addQty) - fee*(qty_a + existQty + addQty)*T = 0
          // where addQty = addNotional/prp, addNotional = addMargin * lev, newAvg = (existNotional + addNotional)/(existQty + addQty)
          //
          // This is complex, so we solve numerically (binary search for addMargin)
          const lockedPnlAtT = lockedSign * (prt - lockedEp) * lockedQty;

          // Function: given addMargin, what is net PnL at target price?
          const netAtTarget = (addMargin) => {
            const addNotional = addMargin * pyraCounter.lev;
            const addQty = addNotional / prp;
            const tNotional = existCounterNotional + addNotional;
            const tQty = existCounterQty + addQty;
            const tAvg = tQty > 0 ? tNotional / tQty : 0;
            const counterPnl = counterSign * (prt - tAvg) * tQty;
            const closeFees = (lockedQty + tQty) * prt * fee;
            return lockedPnlAtT + counterPnl - closeFees;
          };

          // Check if already reversed without adding anything
          const netZero = netAtTarget(0);

          if (netZero >= 0) {
            pyraRevResult = { alreadyReversed: true };
          } else {
            // Binary search for addMargin that makes netAtTarget = 0
            let lo = 0, hi = 100000, found = false, resultMargin = 0;
            for (let iter = 0; iter < 100; iter++) {
              const mid = (lo + hi) / 2;
              const val = netAtTarget(mid);
              if (Math.abs(val) < 0.01) { resultMargin = mid; found = true; break; }
              if (val < 0) lo = mid; else hi = mid;
            }
            if (!found) resultMargin = (lo + hi) / 2;

            if (resultMargin > 0) {
              const addNotional = resultMargin * pyraCounter.lev;
              const addQty = addNotional / prp;
              const tNotional = existCounterNotional + addNotional;
              const tQty = existCounterQty + addQty;
              const tAvg = tNotional / tQty;
              const tMargin = existCounterMargin + resultMargin;

              // Compute new liq
              let revLiq = null, revLiqDist = null;
              if (mmRate) {
                const revParsed = [...parsed];
                if (pyraCounter) {
                  const idx = revParsed.findIndex((p) => p.id === pyraCounterId);
                  if (idx >= 0) {
                    revParsed[idx] = { ...revParsed[idx], ep: tAvg, mg: tMargin, notional: tNotional, qty: tQty };
                  }
                } else {
                  revParsed.push({
                    id: "pyra-virtual", dir: counterDir, sign: counterSign,
                    ep: tAvg, mg: tMargin, notional: tNotional, qty: tQty, lev: pyraCounter.lev,
                  });
                }
                revLiq = solveLiq(revParsed, mmRate);
                if (revLiq != null && cp > 0) revLiqDist = ((cp - revLiq) / cp) * 100;
              }

              pyraRevResult = {
                alreadyReversed: false,
                neededMargin: resultMargin,
                counterAvg: tAvg,
                counterMargin: tMargin,
                liqPrice: revLiq,
                liqDist: revLiqDist,
                feasible: resultMargin <= Math.max(freeMargin, 0),
                marginInsufficient: resultMargin > Math.max(freeMargin, 0),
              };
            } else {
              pyraRevResult = { impossible: true };
            }
          }
        }
      }
    }

    // ── Pyramiding split optimization ──
    let pyraSplitResult = null;
    if (pyraCounter && pyraMode && pyraSubMode === "sim" && pyraSplitMode) {
      const sTotal = n(pyraSplitTotal);
      const prices = pyraSplitPrices.map((p) => n(p)).filter((p) => p > 0);
      const sCount = prices.length;

      if (sTotal > 0 && sCount >= 2) {
        const isCounterLong = pyraCounter.dir === "long";
        // For pyramiding: sort by distance from current price
        const sorted = [...prices].sort((a, b) => isCounterLong ? b - a : a - b);

        const strategies = [
          { name: "균등", desc: "동일 금액", weights: sorted.map(() => 1) },
          { name: "초기 집중", desc: "빠른 역전 추구", weights: sorted.map((_, i) => sCount - i) },
          { name: "확인 후 증액", desc: "추세 확인 후", weights: sorted.map((_, i) => i + 1) },
          { name: "마틴게일", desc: "⚠ 고위험", weights: sorted.map((_, i) => Math.pow(2, i)) },
        ];

        const results = strategies.map((strat) => {
          const totalWeight = strat.weights.reduce((a, w) => a + w, 0);
          const entries = sorted.map((price, i) => {
            const rawMargin = sTotal * strat.weights[i] / totalWeight;
            const conv = fromInput(rawMargin, price, pyraCounter.lev, fee, pyraCounter.dir, pyraCounter.coin);
            if (!conv) return { price, rawMargin, margin: 0, feeDeduct: 0, notional: 0, qty: 0 };
            return { price, rawMargin, margin: conv.margin, feeDeduct: conv.openCost + conv.closeCost, notional: conv.size, qty: conv.qty };
          });
          return { name: strat.name, desc: strat.desc, entries };
        });

        pyraSplitResult = {
          prices: sorted, results,
          totalMargin: sTotal,
          marginInsufficient: sTotal > Math.max(freeMargin, 0),
        };
      }
    }

    // ── 동시청산 계산기 ──
    const hedgePairs = [];
    const pairCoins = [...new Set(parsed.map(p => p.coin))];
    pairCoins.forEach(coin => {
      const longPos = parsed.find(p => p.coin === coin && p.dir === "long");
      const shortPos = parsed.find(p => p.coin === coin && p.dir === "short");
      if (!longPos || !shortPos) return;

      const coinCp = n(coinPrices[coin] || "");
      if (coinCp <= 0) return;

      const lr = Math.min(Math.max(n(scCloseRatios[coin]?.long || "100") / 100, 0), 1);
      const sr = Math.min(Math.max(n(scCloseRatios[coin]?.short || "100") / 100, 0), 1);
      const target = n(scTargets[coin] || "");

      const closeLq = longPos.qty * lr;
      const closeSq = shortPos.qty * sr;
      if (closeLq <= 0 && closeSq <= 0) return;

      // 진입 수수료 (이미 지불됨) = 청산되는 수량의 진입 노셔널 × fee
      const entryFees = (closeLq * longPos.ep + closeSq * shortPos.ep) * fee;

      // P에 대한 1차방정식 분모
      const denom = closeLq - closeSq - (closeLq + closeSq) * fee;

      // 가격별 계산 함수
      const longPnLAt = (P) => (P - longPos.ep) * closeLq;
      const shortPnLAt = (P) => (shortPos.ep - P) * closeSq;
      const closeFeeAt = (P) => (closeLq + closeSq) * P * fee;
      const netCloseAt = (P) => longPnLAt(P) + shortPnLAt(P) - closeFeeAt(P);
      const netAllAt = (P) => netCloseAt(P) - entryFees;

      // 본전가 / 목표가 역산
      const constTerm = longPos.ep * closeLq - shortPos.ep * closeSq;
      let breakevenClose = null, breakevenAll = null, targetPrice = null;

      if (Math.abs(denom) > 1e-12) {
        const beC = constTerm / denom;
        if (beC > 0) breakevenClose = beC;

        const beA = (constTerm + entryFees) / denom;
        if (beA > 0) breakevenAll = beA;

        if (target > 0) {
          const tp = (constTerm + entryFees + target) / denom;
          if (tp > 0) targetPrice = tp;
        }
      }

      // 시나리오 테이블
      const scenarios = [];
      [-10, -5, -3, -1, 0, 1, 3, 5, 10].forEach(pv => {
        const P = coinCp * (1 + pv / 100);
        scenarios.push({
          label: pv === 0 ? "현재가" : `${pv > 0 ? "+" : ""}${pv}%`,
          price: P, longPnL: longPnLAt(P), shortPnL: shortPnLAt(P),
          closeFee: closeFeeAt(P), netClose: netCloseAt(P), netAll: netAllAt(P),
          isCurrent: pv === 0,
        });
      });
      if (breakevenAll) scenarios.push({ label: "본전(전체)", price: breakevenAll, longPnL: longPnLAt(breakevenAll), shortPnL: shortPnLAt(breakevenAll), closeFee: closeFeeAt(breakevenAll), netClose: netCloseAt(breakevenAll), netAll: 0, isSpecial: true });
      if (breakevenClose) scenarios.push({ label: "본전(청산)", price: breakevenClose, longPnL: longPnLAt(breakevenClose), shortPnL: shortPnLAt(breakevenClose), closeFee: closeFeeAt(breakevenClose), netClose: 0, netAll: netAllAt(breakevenClose), isSpecial: true });
      if (targetPrice) scenarios.push({ label: "목표", price: targetPrice, longPnL: longPnLAt(targetPrice), shortPnL: shortPnLAt(targetPrice), closeFee: closeFeeAt(targetPrice), netClose: netCloseAt(targetPrice), netAll: target, isSpecial: true });
      scenarios.sort((a, b) => a.price - b.price);

      hedgePairs.push({
        coin, coinCp, long: longPos, short: shortPos,
        lr, sr, closeLq, closeSq, entryFees,
        breakevenAll, breakevenClose, targetPrice,
        beAllDist: breakevenAll ? ((breakevenAll - coinCp) / coinCp) * 100 : null,
        beCloseDist: breakevenClose ? ((breakevenClose - coinCp) / coinCp) * 100 : null,
        targetDist: targetPrice ? ((targetPrice - coinCp) / coinCp) * 100 : null,
        currentLongPnL: longPnLAt(coinCp), currentShortPnL: shortPnLAt(coinCp),
        currentCloseFee: closeFeeAt(coinCp),
        currentNetClose: netCloseAt(coinCp), currentNetAll: netAllAt(coinCp),
        scenarios, target,
      });
    });

    return {
      parsed, wb, cp, fee, exLiq, calcRefCoin, autoLiqPrices, solveLiqForCoin,
      totalPnL, equity, totalMargin, freeMargin,
      mmActual, mmRate, liqDistPct,
      sel, dcaResult, revResult, closeResult, splitResult, availCalc,
      pyraResult, pyraRevResult, pyraSplitResult,
      pyraLocked, pyraCounter,
      hedgePairs, hedgeResult,
    };
  }, [wallet, coinPrices, feeRate, coinLiqPrices, positions, selId, dcaMode, dcaEntries, revPrice, revTarget, targetAvail, closeRatio, closePrice, splitMode, splitTotal, splitPrices, pyraMode, pyraLockedId, pyraCounterId, pyraSubMode, pyraEntries, pyraRevPrice, pyraRevTarget, pyraSplitMode, pyraSplitTotal, pyraSplitPrices, scCloseRatios, scTargets, hedgeId, hedgeEntry, hedgeMargin, hedgeLev]);

  const selPos = positions.find((p) => p.id === selId);

  /* ═══════════════════════════════════════════
     HEDGE CYCLE CALC
     ═══════════════════════════════════════════ */
  const hcCalc = useMemo(() => {
    const cp = getCp(primaryCoin);
    const wb = n(wallet);
    const baseMg = n(hcMargin);
    const lev = n(hcLeverage);
    const takeROE = n(hcTakeROE);
    const cutRatio = n(hcCutRatio) / 100;
    const recovROE = n(hcRecoveryROE);
    const killPct = n(hcKillPct) / 100;
    const fee = n(feeRate) / 100;

    const longEp = n(hcLongEntry);
    const shortEp = n(hcShortEntry);
    const longMg = n(hcLongMargin) || baseMg;
    const shortMg = n(hcShortMargin) || baseMg;

    if (!cp || !wb || !baseMg || !lev) return null;

    // 포지션 계산
    const longNotional = longMg * lev;
    const shortNotional = shortMg * lev;
    const longQty = longEp > 0 ? longNotional / longEp : 0;
    const shortQty = shortEp > 0 ? shortNotional / shortEp : 0;

    // ROE = (미실현손익 / 전략마진) × 100
    const longPnL = longQty > 0 ? (cp - longEp) * longQty : 0;
    const shortPnL = shortQty > 0 ? (shortEp - cp) * shortQty : 0;
    const longROE = baseMg > 0 ? (longPnL / baseMg) * 100 : 0;
    const shortROE = baseMg > 0 ? (shortPnL / baseMg) * 100 : 0;

    // 밸런스 비율
    const ratio = longMg > 0 && shortMg > 0 ? Math.max(longMg, shortMg) / Math.min(longMg, shortMg) : 0;
    const isBalanced = Math.abs(longMg - shortMg) < baseMg * 0.1; // 10% 이내면 balanced

    // 상태 판별
    let state = 1; // 기본 Balanced
    let winner = null; // "long" | "short"
    let loser = null;
    let winnerROE = 0, loserROE = 0;

    if (!isBalanced) {
      // 2:1 비율 — Imbalanced
      state = 2;
      if (longMg > shortMg) {
        winner = "long"; loser = "short";
        winnerROE = longROE; loserROE = shortROE;
      } else {
        winner = "short"; loser = "long";
        winnerROE = shortROE; loserROE = longROE;
      }
      // 복구 조건 체크: loser가 recovROE 이상이면 state 3
      if (loserROE >= recovROE) {
        state = 3;
      }
    } else {
      // Balanced — winner/loser 판별
      if (longROE > shortROE) {
        winner = "long"; loser = "short";
      } else {
        winner = "short"; loser = "long";
      }
      winnerROE = winner === "long" ? longROE : shortROE;
      loserROE = loser === "long" ? longROE : shortROE;
    }

    // 트리거 가격 역산
    // ROE = ((CP - EP) * qty / baseMg) * 100 = takeROE
    // for long: CP = EP + (takeROE/100 * baseMg / qty)
    // for short: CP = EP - (takeROE/100 * baseMg / qty)
    let longTriggerPrice = null, shortTriggerPrice = null;
    if (longQty > 0) longTriggerPrice = longEp + (takeROE / 100 * baseMg) / longQty;
    if (shortQty > 0) shortTriggerPrice = shortEp - (takeROE / 100 * baseMg) / shortQty;

    // 복구 가격 역산 (loser의 ROE가 recovROE가 되는 가격)
    let recoveryPrice = null;
    if (state === 2 && loser) {
      const loserEp = loser === "long" ? longEp : shortEp;
      const loserQty = loser === "long" ? longQty : shortQty;
      const loserMgNow = loser === "long" ? longMg : shortMg;
      if (loserQty > 0) {
        if (loser === "long") {
          recoveryPrice = loserEp + (recovROE / 100 * baseMg) / loserQty;
        } else {
          recoveryPrice = loserEp - (recovROE / 100 * baseMg) / loserQty;
        }
      }
    }

    // 프로그레스: winner ROE / takeROE
    const winnerProgress = takeROE > 0 ? Math.min(Math.max(winnerROE / takeROE, 0), 1) : 0;

    // 복구 프로그레스
    let recoveryProgress = 0;
    if (state === 2 && loserROE < recovROE) {
      // loser가 심한 마이너스에서 0%까지 올라와야 함
      const loserBasePnL = loser === "long" ? longPnL : shortPnL;
      const loserTargetPnL = recovROE / 100 * baseMg;
      const range = Math.abs(loserTargetPnL - loserBasePnL);
      recoveryProgress = range > 0 ? Math.min(1 - Math.abs(loserBasePnL - loserTargetPnL) / (Math.abs(loserBasePnL) + Math.abs(loserTargetPnL) + 0.01), 1) : 1;
    }

    // 킬 스위치
    const killThreshold = wb * (1 - killPct);
    const totalPnL = longPnL + shortPnL;
    const equity = wb + totalPnL;
    const equityPct = wb > 0 ? (equity / wb) * 100 : 100;
    const killAlert = equity <= killThreshold;

    // 상태별 액션 + 손익 시뮬레이션
    let actions = [];
    let cycleProfit = null;

    const buildCycleProfit = (wROE, lROE, wSide, lSide) => {
      const wPnL = wSide === "long" ? longPnL : shortPnL;
      const wQty = wSide === "long" ? longQty : shortQty;
      const wNotional = wSide === "long" ? longNotional : shortNotional;
      const lPnL = lSide === "long" ? longPnL : shortPnL;
      const lQty = lSide === "long" ? longQty : shortQty;
      const lNotional = lSide === "long" ? longNotional : shortNotional;
      const lMg = lSide === "long" ? longMg : shortMg;

      const winCloseFee = wQty * cp * fee;
      const reentryNotional = baseMg * lev;
      const reentryFee = reentryNotional * fee;
      const loserCutPnL = lPnL * cutRatio; // 음수
      const loserCutFee = lQty * cutRatio * cp * fee;

      const netProfit = wPnL - winCloseFee - reentryFee + loserCutPnL - loserCutFee;
      const totalVolume = wNotional + reentryNotional + lNotional * cutRatio;

      return {
        winProfit: wPnL, winCloseFee, reentryFee,
        loserCutPnL, loserCutFee, netProfit, totalVolume,
        loserRemainMg: lMg * (1 - cutRatio),
      };
    };

    // State 1: winner가 takeROE 도달
    if (state === 1 && winnerROE >= takeROE) {
      cycleProfit = buildCycleProfit(winnerROE, loserROE, winner, loser);
      actions = [
        { label: `${winner === "long" ? "롱" : "숏"} 전량 익절`, detail: `수익 +${fmt(cycleProfit.winProfit)} (수수료 -${fmt(cycleProfit.winCloseFee)})`, type: "profit" },
        { label: `${winner === "long" ? "롱" : "숏"} ${fmt(baseMg, 0)} USDT 재진입`, detail: `수수료 -${fmt(cycleProfit.reentryFee)}`, type: "entry" },
        { label: `${loser === "long" ? "롱" : "숏"} ${n(hcCutRatio)}% 손절`, detail: `손실 ${fmt(cycleProfit.loserCutPnL)} (수수료 -${fmt(cycleProfit.loserCutFee)})`, type: "loss" },
      ];
    }
    // State 2: winner가 또 takeROE 도달 (원웨이 시나리오 B)
    else if (state === 2 && winnerROE >= takeROE) {
      cycleProfit = buildCycleProfit(winnerROE, loserROE, winner, loser);
      actions = [
        { label: `${winner === "long" ? "롱" : "숏"} 전량 익절`, detail: `수익 +${fmt(cycleProfit.winProfit)} (수수료 -${fmt(cycleProfit.winCloseFee)})`, type: "profit" },
        { label: `${winner === "long" ? "롱" : "숏"} ${fmt(baseMg, 0)} USDT 재진입`, detail: `수수료 -${fmt(cycleProfit.reentryFee)}`, type: "entry" },
        { label: `${loser === "long" ? "롱" : "숏"} 잔여 ${n(hcCutRatio)}% 추가 손절`, detail: `손실 ${fmt(cycleProfit.loserCutPnL)} → 잔여 ${fmt(cycleProfit.loserRemainMg, 0)}`, type: "loss" },
      ];
    }
    // State 3: loser 복구
    else if (state === 3) {
      const fillAmount = baseMg - (loser === "long" ? longMg : shortMg);
      const fillFee = fillAmount * lev * fee;
      actions = [
        { label: `${loser === "long" ? "롱" : "숏"} ${fmt(fillAmount, 0)} USDT 추가 진입`, detail: `마진 ${fmt(baseMg, 0)}으로 복구 (수수료 -${fmt(fillFee)})`, type: "recovery" },
      ];
    }

    // 알림 가격 배열
    const alertPrices = [];
    if (longTriggerPrice && longTriggerPrice > 0) {
      alertPrices.push({ label: "롱 익절 트리거", price: longTriggerPrice, color: "#34d399" });
    }
    if (shortTriggerPrice && shortTriggerPrice > 0) {
      alertPrices.push({ label: "숏 익절 트리거", price: shortTriggerPrice, color: "#f87171" });
    }
    if (recoveryPrice && recoveryPrice > 0) {
      alertPrices.push({ label: `${loser === "long" ? "롱" : "숏"} 복구 (본전)`, price: recoveryPrice, color: "#0ea5e9" });
    }

    // 킬 스위치 근접 가격 역산
    // equity(P) = wb + longQty*(P-longEp) + shortQty*(shortEp-P)
    // = wb + P*(longQty-shortQty) - longQty*longEp + shortQty*shortEp
    // killThreshold = wb + P*(longQty-shortQty) - longQty*longEp + shortQty*shortEp
    let killPrice = null;
    if (longQty > 0 && shortQty > 0) {
      const netQty = longQty - shortQty;
      const constPart = wb - longQty * longEp + shortQty * shortEp;
      if (Math.abs(netQty) > 1e-12) {
        const kp = (killThreshold - constPart) / netQty;
        if (kp > 0) killPrice = kp;
      }
    }
    if (killPrice && killPrice > 0) {
      alertPrices.push({ label: "⚠ 킬 스위치", price: killPrice, color: "#f87171" });
    }

    // 원웨이 시나리오 (연속 +40% 시 loser 축소 경로)
    const onewayScenario = [];
    if (longEp > 0 && shortEp > 0 && baseMg > 0) {
      let simLoserMg = isBalanced ? baseMg : Math.min(longMg, shortMg);
      let simCumProfit = 0;
      let simCumVolume = 0;
      for (let i = 0; i < 6 && simLoserMg > 1; i++) {
        const profit = takeROE / 100 * baseMg;
        const loss = (simLoserMg * cutRatio) * (takeROE / 100); // approximate loss
        simCumProfit += profit - loss;
        simCumVolume += baseMg * lev * 2 + simLoserMg * cutRatio * lev;
        simLoserMg = simLoserMg * (1 - cutRatio);
        onewayScenario.push({
          cycle: i + 1, loserMg: simLoserMg,
          cumProfit: simCumProfit, cumVolume: simCumVolume,
        });
      }
    }

    return {
      state, winner, loser,
      longPnL, shortPnL, longROE, shortROE,
      longMg, shortMg, longEp, shortEp,
      longQty, shortQty, longNotional, shortNotional,
      winnerROE, loserROE, winnerProgress,
      longTriggerPrice, shortTriggerPrice, recoveryPrice,
      recoveryProgress,
      actions, cycleProfit, alertPrices, killPrice,
      killThreshold, equity, equityPct, killAlert, totalPnL,
      isBalanced, ratio, onewayScenario,
      baseMg, lev, takeROE, cutRatio, recovROE, fee,
    };
  }, [coinPrices, wallet, feeRate, hcMargin, hcLeverage, hcTakeROE, hcCutRatio, hcRecoveryROE, hcKillPct,
      hcLongEntry, hcShortEntry, hcLongMargin, hcShortMargin]);

  /* ═══════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════ */
  return (
    <div style={S.root}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700;800&family=IBM+Plex+Mono:wght@300;400;500;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        input[type=number]{-moz-appearance:textfield;appearance:textfield}
        input::-webkit-outer-spin-button,input::-webkit-inner-spin-button{-webkit-appearance:none}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#2a2a3a;border-radius:2px}
        select{cursor:pointer}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
      `}</style>

      <div style={S.wrap}>
        {/* HEADER */}
        <header style={S.hdr}>
          <div style={S.hdrRow}>
            <div style={{ ...S.hdrDot, background: priceSourceColor, boxShadow: `0 0 8px ${priceSourceColor}44` }} />
            <span style={S.hdrBadge}>TAPBIT SYNC · CROSS MARGIN</span>
          </div>
          <h1 style={S.hdrTitle}>COINSTEP PRO</h1>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
            <div style={{ fontSize: 10, color: "#4b5563", fontFamily: "'DM Sans'", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                display: "inline-block", width: 5, height: 5, borderRadius: "50%",
                background: priceSourceColor,
                animation: priceSource === "reconnecting" ? "pulse 1s infinite" : "none",
              }} />
              <span style={{ color: priceSourceColor }}>{priceSourceLabel}</span>
              {lastSyncTime && (
                <span style={{ color: "#334155" }}>· 동기화 {Math.floor((Date.now() - lastSyncTime) / 1000)}초 전</span>
              )}
            </div>
            {tapbitData?.profile?.remarkName && (
              <span style={{ fontSize: 10, color: "#34d399", fontFamily: "'DM Sans'" }}>
                {tapbitData.profile.remarkName}
              </span>
            )}
          </div>
        </header>

        {/* ── 유저 미선택: 유저 리스트 ── */}
        {!selectedUser && (
          <div>
            {parsedUsers.length === 0 ? (
              <div style={{
                padding: 40, textAlign: "center", borderRadius: 12,
                background: "linear-gradient(135deg, #0a0e1a 0%, #080c16 100%)",
                border: "1px solid #0ea5e922",
              }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📡</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", marginBottom: 8, fontFamily: "'DM Sans'" }}>
                  Tapbit 동기화 대기 중
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.8, fontFamily: "'DM Sans'" }}>
                  크롬 확장에서 <strong style={{ color: "#34d399" }}>🔄 동기화</strong>를 실행하면<br />
                  유저 포지션이 자동으로 표시됩니다
                </div>
              </div>
            ) : (
              <>
                <Sec label={`유저 목록 (${parsedUsers.length}명)`} />
                {parsedUsers.map(user => {
                  const totalPnL = user.positions.reduce((a, p) => a + Number(p.unrealisedPnl || 0), 0);
                  const totalMargin = user.positions.reduce((a, p) => a + Number(p.margin || 0), 0);
                  const wb = Number(user.wallet);
                  const equity = wb + totalPnL;
                  const avgRoe = totalMargin > 0 ? (totalPnL / totalMargin) * 100 : 0;
                  const riskColor = avgRoe < -200 ? "#f87171" : avgRoe < -100 ? "#f59e0b" : avgRoe < 0 ? "#94a3b8" : "#34d399";
                  const riskIcon = avgRoe < -200 ? "🔴" : avgRoe < -100 ? "🟡" : avgRoe >= 0 ? "🟢" : "⚪";
                  return (
                    <div key={user.maskId} onClick={() => selectUser(user.maskId)} style={{
                      ...S.card, cursor: "pointer", transition: "border-color 0.15s, background 0.15s",
                      borderColor: "#1e1e2e", marginBottom: 8,
                    }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#0ea5e944"; e.currentTarget.style.background = "#060a14"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.background = "#08080f"; }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span>{riskIcon}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", fontFamily: "'DM Sans'" }}>{user.label}</span>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", fontFamily: "'IBM Plex Mono'" }}>
                          {fmt(wb, 0)} USDT
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 12, fontSize: 11, color: "#6b7280", fontFamily: "'DM Sans'" }}>
                        <span>포지션 {user.positions.length}개</span>
                        <span>{[...new Set(user.positions.map(p => p.coin))].join("/")}</span>
                        <span>{[...new Set(user.positions.map(p => p.dir === "long" ? "롱" : "숏"))].join("+")}</span>
                        <span style={{ color: riskColor, fontWeight: 600 }}>
                          PnL {fmtS(totalPnL)} ({fmtS(avgRoe)}%)
                        </span>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {/* ── 유저 선택됨: 상세 화면 ── */}
        {selectedUser && (
          <>
            {/* 유저 헤더 + 뒤로가기 */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10, marginBottom: 12,
              padding: "10px 14px", borderRadius: 10,
              background: "#08080f", border: "1px solid #34d39933",
            }}>
              <button onClick={() => setSelectedUserId(null)} style={{
                padding: "6px 10px", fontSize: 11, borderRadius: 6,
                border: "1px solid #1e1e2e", background: "transparent",
                color: "#6b7280", cursor: "pointer", fontFamily: "'DM Sans'",
              }}>← 목록</button>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", fontFamily: "'DM Sans'" }}>
                  {selectedUser.label}
                </div>
                <div style={{ fontSize: 10, color: "#4b5563", fontFamily: "'DM Sans'" }}>
                  잔고 {fmt(Number(selectedUser.wallet), 0)} USDT · 포지션 {selectedUser.positions.length}개
                  {usedCoins.length > 0 && coinFundingRates[usedCoins[0]] && (
                    <span style={{ marginLeft: 8, color: Number(coinFundingRates[usedCoins[0]]) >= 0 ? "#34d399" : "#f87171" }}>
                      {usedCoins[0]} 펀딩 {(Number(coinFundingRates[usedCoins[0]]) * 100).toFixed(4)}%
                    </span>
                  )}
                </div>
              </div>
              {/* 현재가 표시 */}
              {usedCoins.map(coin => (
                <div key={coin} style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 10, color: "#4b5563" }}>{coin}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: getCp(coin) > 0 ? "#e2e8f0" : "#4b5563", fontFamily: "'IBM Plex Mono'" }}>
                    {getCp(coin) > 0 ? fmt(getCp(coin), getCp(coin) > 100 ? 2 : 4) : "—"}
                  </div>
                </div>
              ))}
            </div>

            {/* TAB NAVIGATION */}
            <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
              {[
                { id: "sim", label: "물타기 · 불타기" },
                { id: "hedge", label: "헷지 사이클" },
              ].map((tab) => (
                <button key={tab.id} onClick={() => setAppTab(tab.id)} style={{
                  flex: 1, padding: "12px 0", fontSize: 13, fontWeight: 700, borderRadius: 10,
                  border: `1px solid ${appTab === tab.id ? "#0ea5e944" : "#1e1e2e"}`,
                  background: appTab === tab.id ? "#0ea5e910" : "transparent",
                  color: appTab === tab.id ? "#0ea5e9" : "#4b5563",
                  cursor: "pointer", fontFamily: "'DM Sans'", transition: "all 0.15s",
                  letterSpacing: 0.5,
                }}>{tab.label}</button>
              ))}
            </div>

            {/* ══════ SIMULATOR TAB ══════ */}
            {appTab === "sim" && (<>

            {/* ② POSITIONS (읽기 전용) */}
            <Sec label="포지션" />
            {positions.map((pos, idx) => (
              <Fragment key={pos.id}>
                <PosCard pos={pos} idx={idx}
                  isSel={pos.id === selId}
                  isHedge={pos.id === hedgeId}
                  isPyraLocked={pyraMode && pos.id === pyraLockedId}
                  isPyraCounter={pyraMode && pos.id === pyraCounterId}
                  onSelect={() => selectPos(pos.id)}
                  onPyra={() => selectPyra(pos.id)}
                  onHedge={() => selectHedge(pos.id)}
                  cp={getCp(pos.coin)} fee={n(feeRate)/100} />
                {pos.id === hedgeId && (
                  <HedgePanel
                    pos={pos} calc={calc}
                    hedgeEntry={hedgeEntry} setHedgeEntry={setHedgeEntry}
                    hedgeMargin={hedgeMargin} setHedgeMargin={setHedgeMargin}
                    hedgeLev={hedgeLev} setHedgeLev={setHedgeLev}
                    hedgeLive={hedgeLive} setHedgeLive={setHedgeLive}
                    getCp={getCp}
                  />
                )}
              </Fragment>
            ))}

        {/* ③ ACCOUNT SUMMARY */}
        {calc && hasAnyPrice && (
          <>
            <Sec label="계좌 요약" />
            <div style={S.summaryGrid}>
              <SumCard label="총 미실현 PnL" value={`${fmtS(calc.totalPnL)} USDT`}
                color={calc.totalPnL >= 0 ? "#34d399" : "#f87171"} />
              <SumCard label="유효 잔고 (Equity)" value={`${fmt(calc.equity)} USDT`}
                color="#e2e8f0" />
              <SumCard label="사용 마진" value={`${fmt(calc.totalMargin)} USDT`}
                color="#94a3b8" />
              <SumCard label="사용 가능" value={`${fmt(calc.freeMargin)} USDT`}
                color={calc.freeMargin > 0 ? "#34d399" : "#f87171"}
                sub="미실현 이익 미반영 (Bybit)" />
            </div>

            {/* Available amount target */}
            <div style={S.availBox}>
              <div style={S.availRow}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>목표 사용 가능 금액</div>
                  <Inp value={targetAvail} onChange={setTargetAvail} ph="목표 금액 (USDT)" />
                </div>
                <div style={{ flex: 1, paddingLeft: 12, display: "flex", alignItems: "flex-end" }}>
                  {calc.availCalc ? (
                    calc.availCalc.sufficient ? (
                      <div style={{ fontSize: 13, color: "#34d399", fontWeight: 600, paddingBottom: 10 }}>
                        ✓ 현재 충분
                      </div>
                    ) : calc.availCalc.impossible ? (
                      <div style={{ paddingBottom: 6 }}>
                        <div style={{ fontSize: 10, color: "#f87171", fontWeight: 600, marginBottom: 4 }}>
                          가격 변동만으로 도달 불가
                        </div>
                        <div style={{ fontSize: 11, color: "#94a3b8" }}>
                          최대 확보 가능: <span style={{ color: "#f59e0b", fontWeight: 600 }}>{fmt(calc.availCalc.maxAvail)} USDT</span>
                        </div>
                        <div style={{ fontSize: 10, color: "#4b5563", marginTop: 2 }}>
                          (${fmt(calc.availCalc.maxAvailPrice)} · {fmtS(calc.availCalc.maxChangePct)}%)
                        </div>
                      </div>
                    ) : (
                      <div style={{ paddingBottom: 6 }}>
                        <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>필요 가격</div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: "#0ea5e9", fontFamily: "'DM Sans'" }}>
                          ${fmt(calc.availCalc.neededPrice)}
                        </div>
                        <div style={{ fontSize: 11, color: calc.availCalc.direction === "up" ? "#34d399" : "#f87171", marginTop: 2 }}>
                          현재가 대비 {fmtS(calc.availCalc.changePct)}% {calc.availCalc.direction === "up" ? "↑" : "↓"}
                        </div>
                      </div>
                    )
                  ) : (
                    <div style={{ fontSize: 11, color: "#333", paddingBottom: 10 }}>
                      금액 입력 시 필요 가격 표시
                    </div>
                  )}
                </div>
              </div>

              {/* 달성 방법 가이드 */}
              {calc.availCalc && !calc.availCalc.sufficient && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #1e1e2e" }}>
                  <div style={{ fontSize: 10, color: "#0ea5e9", fontWeight: 700, letterSpacing: 1.5, fontFamily: "'DM Sans'", marginBottom: 10 }}>
                    📊 달성 방법
                  </div>

                  {/* ① 가격 변동 분석 */}
                  {calc.availCalc.neededPrice && !calc.availCalc.impossible && (!calc.availCalc.coinAnalysis || calc.availCalc.coinAnalysis.length <= 1) && (
                    <div style={{ padding: "8px 10px", borderRadius: 6, background: "#0ea5e908", border: "1px solid #0ea5e922", marginBottom: 8, fontSize: 11, color: "#94a3b8" }}>
                      <span style={{ color: "#0ea5e9", fontWeight: 600 }}>① 가격 변동</span>
                      {" · "}{calc.calcRefCoin} → <span style={{ fontWeight: 600, color: "#e2e8f0" }}>${fmt(calc.availCalc.neededPrice)}</span>
                      <span style={{ color: calc.availCalc.direction === "up" ? "#34d399" : "#f87171", marginLeft: 4 }}>
                        ({fmtS(calc.availCalc.changePct)}%)
                      </span>
                    </div>
                  )}
                  {(calc.availCalc.impossible || (calc.availCalc.coinAnalysis && calc.availCalc.coinAnalysis.length > 1)) && (
                    <div style={{ padding: "8px 10px", borderRadius: 6, background: calc.availCalc.bestCoinSolution ? "#0ea5e908" : "#f8717108", border: `1px solid ${calc.availCalc.bestCoinSolution ? "#0ea5e922" : "#f8717122"}`, marginBottom: 8, fontSize: 11 }}>
                      <div style={{ color: "#0ea5e9", fontWeight: 600, marginBottom: 6 }}>① 가격 변동 분석</div>
                      {calc.availCalc.coinAnalysis && calc.availCalc.coinAnalysis.map(ca => (
                        <div key={ca.coin} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", borderBottom: "1px solid #0e0e18" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ fontWeight: 600, color: "#e2e8f0", fontSize: 10, width: 32 }}>{ca.coin}</span>
                            {ca.isHedged && (
                              <span style={{ fontSize: 8, padding: "1px 4px", borderRadius: 3, background: "#f59e0b15", color: "#f59e0b", border: "1px solid #f59e0b33", fontWeight: 600 }}>양방향</span>
                            )}
                          </div>
                          <div style={{ textAlign: "right", color: "#94a3b8" }}>
                            {ca.neededPrice ? (
                              <span>
                                <span style={{ color: "#34d399", fontWeight: 600 }}>${fmt(ca.neededPrice)}</span>
                                <span style={{ color: ca.changePct >= 0 ? "#34d399" : "#f87171", marginLeft: 3 }}>({fmtS(ca.changePct)}%)</span>
                              </span>
                            ) : ca.reason === "양방향 포지션 — 가격 효과 상쇄" ? (
                              <span style={{ color: "#f59e0b" }}>상쇄 · 최대 +{fmt(ca.maxGain)} USDT</span>
                            ) : (
                              <span style={{ color: "#6b7280" }}>최대 +{fmt(ca.maxGain)} USDT</span>
                            )}
                          </div>
                        </div>
                      ))}
                      {/* 결론 */}
                      <div style={{ marginTop: 6, fontSize: 10 }}>
                        {calc.availCalc.bestCoinSolution ? (
                          <span style={{ color: "#0ea5e9", fontWeight: 600 }}>
                            💡 {calc.availCalc.bestCoinSolution.coin} 가격 변동으로 달성 가능
                          </span>
                        ) : calc.availCalc.impossible ? (
                          <span style={{ color: "#f87171" }}>
                            가격만으로 도달 불가 · 부족 <span style={{ fontWeight: 600 }}>{fmt(calc.availCalc.shortfall)} USDT</span>
                            {calc.availCalc.hedgeDetected && <span style={{ color: "#f59e0b", marginLeft: 4 }}>(양방향 포지션으로 가격 효과 제한)</span>}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  )}
                  {calc.availCalc.impossible && (!calc.availCalc.coinAnalysis || calc.availCalc.coinAnalysis.length <= 1) && (
                    <div style={{ padding: "8px 10px", borderRadius: 6, background: "#f8717108", border: "1px solid #f8717122", marginBottom: 8, fontSize: 11, color: "#f87171" }}>
                      <span style={{ fontWeight: 600 }}>① 가격 변동</span> · 가격만으로 도달 불가
                      <span style={{ color: "#94a3b8", marginLeft: 4 }}>
                        (최대 {fmt(calc.availCalc.maxAvail)} USDT, 부족 {fmt(calc.availCalc.shortfall)} USDT)
                      </span>
                      {calc.availCalc.hedgeDetected && (
                        <div style={{ marginTop: 3, color: "#f59e0b", fontSize: 10 }}>
                          ⚠ 양방향 포지션으로 가격 변동 효과가 상쇄됩니다
                        </div>
                      )}
                    </div>
                  )}

                  {/* ② 부분 청산 가이드 */}
                  {calc.availCalc.closeGuide && calc.availCalc.closeGuide.length > 0 && (
                    <div style={{ padding: "8px 10px", borderRadius: 6, background: "#f59e0b08", border: "1px solid #f59e0b22", marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: "#f59e0b", fontWeight: 600, marginBottom: 8 }}>② 부분 청산으로 확보</div>
                      {calc.availCalc.closeGuide.map((g, gi) => {
                        const isLast = gi === calc.availCalc.closeGuide.length - 1;
                        const balVal = g.neededPct !== null ? g.balChangeNeeded : g.balChangeMax;
                        const balColor = balVal >= 0 ? "#34d399" : "#f87171";
                        const safetyStyle = {
                          safe: { bg: "#34d39915", color: "#34d399", border: "#34d39933", icon: "🛡", label: "안전" },
                          caution: { bg: "#f59e0b15", color: "#f59e0b", border: "#f59e0b33", icon: "⚠", label: "주의" },
                          danger: { bg: "#f8717115", color: "#f87171", border: "#f8717133", icon: "🔴", label: "위험" },
                        }[g.liqSafetyTag] || null;
                        return (
                          <div key={g.id} style={{
                            padding: "8px 0", borderBottom: isLast ? "none" : "1px solid #1e1e2e",
                          }}>
                            {/* 1줄: 코인/방향 + PnL태그 + 청산가태그 */}
                            <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                              {g.isRecommended && (
                                <span style={{
                                  fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
                                  background: "#0ea5e920", color: "#0ea5e9", border: "1px solid #0ea5e944",
                                  fontFamily: "'DM Sans'",
                                }}>추천</span>
                              )}
                              <span style={{ color: g.dir === "long" ? "#34d399" : "#f87171", fontWeight: 600, fontSize: 10 }}>
                                {g.coin} {g.dirKr}
                              </span>
                              <span style={{
                                fontSize: 8, fontWeight: 600, padding: "1px 4px", borderRadius: 3,
                                background: g.isProfitable ? "#34d39915" : "#f8717115",
                                color: g.isProfitable ? "#34d399" : "#f87171",
                                border: `1px solid ${g.isProfitable ? "#34d39933" : "#f8717133"}`,
                              }}>
                                {g.isProfitable ? "✨ 무손실" : "💸 손실확정"}
                              </span>
                              {safetyStyle && (
                                <span style={{
                                  fontSize: 8, fontWeight: 600, padding: "1px 4px", borderRadius: 3,
                                  background: safetyStyle.bg, color: safetyStyle.color,
                                  border: `1px solid ${safetyStyle.border}`,
                                }}>
                                  {safetyStyle.icon} 청산가 {safetyStyle.label}
                                </span>
                              )}
                            </div>
                            {/* 2줄: 청산% + 확보금액 + 마진 변화 */}
                            <div style={{ fontSize: 11, marginTop: 4 }}>
                              {g.neededPct !== null ? (
                                <span style={{ color: "#e2e8f0" }}>
                                  <span style={{ fontWeight: 700, color: "#f59e0b" }}>{fmt(g.neededPct, 1)}%</span> 청산 → <span style={{ color: "#34d399", fontWeight: 600 }}>+{fmt(g.neededPct * g.freed1Pct)} USDT</span> 확보
                                  <span style={{ color: "#6b7280", marginLeft: 6 }}>
                                    · 마진 {fmt(g.margin)} → <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{fmt(g.margin * (1 - g.neededPct / 100))}</span>
                                  </span>
                                </span>
                              ) : (
                                <span style={{ color: "#6b7280" }}>
                                  전량 청산해도 부족 <span style={{ color: "#94a3b8" }}>(최대 +{fmt(g.maxFreed)} USDT · 마진 {fmt(g.margin)} → 0)</span>
                                </span>
                              )}
                            </div>
                            {/* 3줄: 잔고 변화 + 청산가 여유 변화 */}
                            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 3, display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <span>
                                잔고 <span style={{ color: balColor, fontWeight: 600 }}>{fmtS(balVal)} USDT</span>
                                {g.isProfitable ? (
                                  <span style={{ marginLeft: 3 }}>(수수료만 차감)</span>
                                ) : (
                                  g.costRatio > 0 && <span style={{ marginLeft: 3 }}>(1$ 당 {fmt(g.costRatio, 2)}$ 손실)</span>
                                )}
                              </span>
                              {g.liqDistChange != null && g.newLiq != null && calc.exLiq > 0 ? (
                                <span>
                                  청산가 <span style={{ color: "#94a3b8" }}>${fmt(calc.exLiq)}</span>
                                  {" → "}
                                  <span style={{ color: Math.abs(g.newLiqDist) > Math.abs(g.curLiqDist) ? "#34d399" : "#f87171", fontWeight: 600 }}>
                                    ${fmt(g.newLiq)}
                                  </span>
                                  <span style={{ color: "#6b7280", marginLeft: 3 }}>
                                    (여유 {fmt(Math.abs(g.curLiqDist), 1)}% → {fmt(Math.abs(g.newLiqDist), 1)}%)
                                  </span>
                                </span>
                              ) : g.liqSafetyTag === "unknown" ? (
                                <span style={{ color: "#333" }}>청산가 미입력</span>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                      <div style={{ fontSize: 9, color: "#4b5563", marginTop: 4, fontFamily: "'DM Sans'" }}>
                        안전 등급순 · 청산가 시뮬레이션 기반
                      </div>
                    </div>
                  )}

                  {/* ③ 추가 입금 */}
                  {calc.availCalc.depositNeeded > 0 && (
                    <div style={{ padding: "8px 10px", borderRadius: 6, background: "#34d39908", border: "1px solid #34d39922", fontSize: 11, color: "#94a3b8" }}>
                      <div>
                        <span style={{ color: "#34d399", fontWeight: 600 }}>③ 추가 입금</span>
                        {" · "}지갑에 <span style={{ fontWeight: 700, color: "#34d399" }}>{fmt(calc.availCalc.depositNeeded)} USDT</span> 입금 시 즉시 달성
                      </div>
                      {calc.availCalc.depositLiq != null && calc.exLiq > 0 && (
                        <div style={{ fontSize: 10, color: "#6b7280", marginTop: 4 }}>
                          청산가 <span style={{ color: "#94a3b8" }}>${fmt(calc.exLiq)}</span>
                          {" → "}
                          <span style={{ color: "#34d399", fontWeight: 600 }}>${fmt(calc.availCalc.depositLiq)}</span>
                          <span style={{ color: "#6b7280", marginLeft: 3 }}>
                            (여유 {fmt(Math.abs(calc.liqDistPct), 1)}% → {fmt(Math.abs(calc.availCalc.depositLiqDist), 1)}%)
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Liquidation info */}
            {calc?.exLiq > 0 ? (
              <div style={S.liqBar}>
                <div style={S.liqBarInner}>
                  <div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>
                      강제 청산가 <span style={{ color: "#4b5563" }}>({calc.calcRefCoin})</span>
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#f59e0b", fontFamily: "'DM Sans'" }}>
                      ${fmt(calc.exLiq)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>현재가 대비 여유</div>
                    <div style={{
                      fontSize: 20, fontWeight: 700, fontFamily: "'DM Sans'",
                      color: Math.abs(calc.liqDistPct || 0) > 50 ? "#34d399" : Math.abs(calc.liqDistPct || 0) > 20 ? "#f59e0b" : "#f87171",
                    }}>
                      {calc.liqDistPct != null ? `${fmt(Math.abs(calc.liqDistPct))}%` : "—"}
                    </div>
                  </div>
                </div>
                {/* 다중 코인 자동계산 청산가 */}
                {Object.keys(calc.autoLiqPrices).length > 0 && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #1e1e2e" }}>
                    {Object.entries(calc.autoLiqPrices).map(([coin, liq]) => {
                      const coinCp = getCp(coin);
                      const dist = coinCp > 0 ? ((coinCp - liq) / coinCp) * 100 : null;
                      return (
                        <div key={coin} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", fontFamily: "'IBM Plex Mono'", width: 40 }}>{coin}</span>
                            <span style={{ fontSize: 14, fontWeight: 600, color: "#f59e0b", fontFamily: "'DM Sans'" }}>
                              ${fmt(liq, liq > 100 ? 2 : 4)}
                            </span>
                            <span style={{ fontSize: 9, color: "#0ea5e966", fontFamily: "'DM Sans'" }}>자동</span>
                          </div>
                          {dist != null && (
                            <span style={{
                              fontSize: 11, fontWeight: 600, fontFamily: "'DM Sans'",
                              color: Math.abs(dist) > 50 ? "#34d399" : Math.abs(dist) > 20 ? "#f59e0b" : "#f87171",
                            }}>
                              여유 {fmt(Math.abs(dist))}%
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Visual bar */}
                {calc.liqDistPct != null && (
                  <div style={S.liqVisual}>
                    <div style={S.liqTrack}>
                      <div style={{
                        ...S.liqFill,
                        width: `${Math.min(Math.abs(calc.liqDistPct), 100)}%`,
                        background: Math.abs(calc.liqDistPct) > 50 ? "#34d399" : Math.abs(calc.liqDistPct) > 20 ? "#f59e0b" : "#f87171",
                      }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#4b5563", marginTop: 3 }}>
                      <span>청산</span>
                      <span>현재가</span>
                    </div>
                  </div>
                )}

              </div>
            ) : (
              <div style={S.liqEmpty}>
                거래소 강제 청산가를 입력하면 청산가 분석이 표시됩니다
              </div>
            )}

            {/* ── 🔥 Simultaneous close summary (pyra mode) ── */}
            {pyraMode && calc.pyraResult && calc.cp > 0 && (
              <div style={{
                marginTop: 10, padding: 16, borderRadius: 10,
                background: "#0c0a04", border: "1px solid #f59e0b33",
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#f59e0b", fontFamily: "'DM Sans'", marginBottom: 10 }}>
                  🔥 동시 청산 시
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>합산 PnL</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: calc.pyraResult.combinedPnL >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
                      {fmtS(calc.pyraResult.combinedPnL)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>순손익 (수수료 후)</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: calc.pyraResult.simultaneousClose >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
                      {fmtS(calc.pyraResult.simultaneousClose)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>역전가까지</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#f59e0b", fontFamily: "'IBM Plex Mono'" }}>
                      {calc.pyraResult.reversalPrice
                        ? `${fmtS(calc.pyraResult.reversalDist)}%`
                        : "—"}
                    </div>
                    {calc.pyraResult.reversalPrice && (
                      <div style={{ fontSize: 10, color: "#6b7280" }}>${fmt(calc.pyraResult.reversalPrice)}</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ⚖ HEDGE CLOSE CALCULATOR */}
            {calc.hedgePairs && calc.hedgePairs.length > 0 && calc.hedgePairs.map(pair => (
              <div key={`sc-${pair.coin}`}>
                {/* Section header */}
                <div style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: 2.5, textTransform: "uppercase",
                  color: "#10b981", fontFamily: "'DM Sans'",
                  margin: "28px 0 10px", display: "flex", alignItems: "center", gap: 8,
                }}>
                  <div style={{ width: 3, height: 14, background: "#10b981", borderRadius: 2 }} />
                  동시청산 — {pair.coin}
                </div>

                {/* Position summary + close ratios */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                  {/* Long */}
                  <div style={{ padding: 12, borderRadius: 10, background: "#08080f", border: "1px solid #34d39933" }}>
                    <div style={{ fontSize: 10, color: "#34d399", fontWeight: 700, marginBottom: 6, fontFamily: "'DM Sans'" }}>롱</div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 2 }}>진입 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>${fmt(pair.long.ep, pair.long.ep > 100 ? 2 : 4)}</span></div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 2 }}>마진 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{fmt(pair.long.mg)}</span> · {pair.long.lev}x</div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>수량 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{fmt(pair.long.qty, 4)}</span></div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 3 }}>청산 비율 (%)</div>
                    <input type="number" value={getScRatio(pair.coin, "long")}
                      onChange={(e) => setScRatio(pair.coin, "long", e.target.value)}
                      style={{ ...S.inp, fontSize: 13, padding: "8px 10px" }}
                      onFocus={(e) => (e.target.style.borderColor = "#10b981")}
                      onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
                    <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
                      {[25, 50, 75, 100].map(v => (
                        <button key={v} onClick={() => setScRatio(pair.coin, "long", String(v))} style={{
                          flex: 1, padding: "3px 0", fontSize: 9, fontWeight: 600, borderRadius: 4,
                          cursor: "pointer", fontFamily: "'DM Sans'", transition: "all 0.12s",
                          border: `1px solid ${getScRatio(pair.coin, "long") === String(v) ? "#10b98166" : "#1e1e2e"}`,
                          background: getScRatio(pair.coin, "long") === String(v) ? "#10b98115" : "transparent",
                          color: getScRatio(pair.coin, "long") === String(v) ? "#10b981" : "#4b5563",
                        }}>{v}%</button>
                      ))}
                    </div>
                  </div>
                  {/* Short */}
                  <div style={{ padding: 12, borderRadius: 10, background: "#08080f", border: "1px solid #f8717133" }}>
                    <div style={{ fontSize: 10, color: "#f87171", fontWeight: 700, marginBottom: 6, fontFamily: "'DM Sans'" }}>숏</div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 2 }}>진입 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>${fmt(pair.short.ep, pair.short.ep > 100 ? 2 : 4)}</span></div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 2 }}>마진 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{fmt(pair.short.mg)}</span> · {pair.short.lev}x</div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>수량 <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{fmt(pair.short.qty, 4)}</span></div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 3 }}>청산 비율 (%)</div>
                    <input type="number" value={getScRatio(pair.coin, "short")}
                      onChange={(e) => setScRatio(pair.coin, "short", e.target.value)}
                      style={{ ...S.inp, fontSize: 13, padding: "8px 10px" }}
                      onFocus={(e) => (e.target.style.borderColor = "#10b981")}
                      onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
                    <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
                      {[25, 50, 75, 100].map(v => (
                        <button key={v} onClick={() => setScRatio(pair.coin, "short", String(v))} style={{
                          flex: 1, padding: "3px 0", fontSize: 9, fontWeight: 600, borderRadius: 4,
                          cursor: "pointer", fontFamily: "'DM Sans'", transition: "all 0.12s",
                          border: `1px solid ${getScRatio(pair.coin, "short") === String(v) ? "#10b98166" : "#1e1e2e"}`,
                          background: getScRatio(pair.coin, "short") === String(v) ? "#10b98115" : "transparent",
                          color: getScRatio(pair.coin, "short") === String(v) ? "#10b981" : "#4b5563",
                        }}>{v}%</button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Fee details */}
                <div style={S.detBox}>
                  <div style={{ ...S.detTitle, color: "#10b981" }}>수수료 내역</div>
                  <div style={S.sl}><span style={{ color: "#6b7280" }}>진입 수수료 (이미 지불)</span><span style={{ color: "#f59e0b" }}>{fmt(pair.entryFees)} USDT</span></div>
                  <div style={S.sl}><span style={{ color: "#6b7280" }}>청산 수수료 (현재가 기준)</span><span style={{ color: "#f59e0b" }}>{fmt(pair.currentCloseFee)} USDT</span></div>
                  <div style={{ ...S.sl, borderBottom: "none", fontWeight: 600 }}><span style={{ color: "#94a3b8" }}>수수료 합계</span><span style={{ color: "#f59e0b" }}>{fmt(pair.entryFees + pair.currentCloseFee)} USDT</span></div>
                </div>

                {/* Break-even prices */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                  <div style={{ padding: 14, borderRadius: 10, background: "#10b98108", border: "1px solid #10b98133", textAlign: "center" }}>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>본전가 (전체 수수료)</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#10b981", fontFamily: "'DM Sans'" }}>
                      {pair.breakevenAll ? `$${fmt(pair.breakevenAll, pair.breakevenAll > 100 ? 2 : 4)}` : "—"}
                    </div>
                    {pair.beAllDist != null && (
                      <div style={{ fontSize: 11, color: pair.beAllDist >= 0 ? "#34d399" : "#f87171", marginTop: 2 }}>
                        현재가 대비 {fmtS(pair.beAllDist)}%
                      </div>
                    )}
                  </div>
                  <div style={{ padding: 14, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e", textAlign: "center" }}>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>본전가 (청산 수수료만)</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#94a3b8", fontFamily: "'DM Sans'" }}>
                      {pair.breakevenClose ? `$${fmt(pair.breakevenClose, pair.breakevenClose > 100 ? 2 : 4)}` : "—"}
                    </div>
                    {pair.beCloseDist != null && (
                      <div style={{ fontSize: 11, color: pair.beCloseDist >= 0 ? "#34d399" : "#f87171", marginTop: 2 }}>
                        현재가 대비 {fmtS(pair.beCloseDist)}%
                      </div>
                    )}
                  </div>
                </div>

                {/* Current price summary */}
                <div style={{ padding: 14, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e", marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 6, fontFamily: "'DM Sans'" }}>
                    현재가 ${fmt(pair.coinCp, pair.coinCp > 100 ? 2 : 4)} 에서 동시 청산 시
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>롱 PnL</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: pair.currentLongPnL >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
                        {fmtS(pair.currentLongPnL)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>숏 PnL</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: pair.currentShortPnL >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
                        {fmtS(pair.currentShortPnL)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>수수료</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#f59e0b", fontFamily: "'IBM Plex Mono'" }}>
                        -{fmt(pair.entryFees + pair.currentCloseFee)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>순손익</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: pair.currentNetAll >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
                        {fmtS(pair.currentNetAll)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Target profit */}
                <div style={{ padding: 14, borderRadius: 10, background: "#08080f", border: "1px solid #10b98122", marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "#10b981", fontWeight: 700, letterSpacing: 2, marginBottom: 8, fontFamily: "'DM Sans'" }}>목표 익절</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>목표 금액 (USDT)</div>
                      <input type="number" value={getScTarget(pair.coin)}
                        onChange={(e) => setScTarget(pair.coin, e.target.value)}
                        placeholder="0"
                        style={{ ...S.inp, fontSize: 13, padding: "8px 10px" }}
                        onFocus={(e) => (e.target.style.borderColor = "#10b981")}
                        onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
                    </div>
                    <div style={{ flex: 1, paddingLeft: 4, display: "flex", alignItems: "flex-end" }}>
                      {pair.targetPrice ? (
                        <div style={{ paddingBottom: 2 }}>
                          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>익절가</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: "#10b981", fontFamily: "'DM Sans'" }}>
                            ${fmt(pair.targetPrice, pair.targetPrice > 100 ? 2 : 4)}
                          </div>
                          <div style={{ fontSize: 11, color: pair.targetDist >= 0 ? "#34d399" : "#f87171", marginTop: 1 }}>
                            현재가 대비 {fmtS(pair.targetDist)}%
                          </div>
                        </div>
                      ) : pair.target > 0 ? (
                        <div style={{ fontSize: 11, color: "#f87171", paddingBottom: 10 }}>도달 불가</div>
                      ) : (
                        <div style={{ fontSize: 11, color: "#333", paddingBottom: 10 }}>금액 입력 시 익절가 표시</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Scenario table */}
                <div style={S.tblWrap}>
                  <table style={S.tbl}>
                    <thead>
                      <tr>
                        <th style={S.th}>가격</th>
                        <th style={{ ...S.th, textAlign: "right" }}>롱 PnL</th>
                        <th style={{ ...S.th, textAlign: "right" }}>숏 PnL</th>
                        <th style={{ ...S.th, textAlign: "right" }}>수수료</th>
                        <th style={{ ...S.th, textAlign: "right" }}>순손익</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pair.scenarios.map((s, i) => (
                        <tr key={i} style={{
                          background: s.isSpecial ? "#10b98108" : s.isCurrent ? "#0ea5e908" : "transparent",
                        }}>
                          <td style={{ ...S.td, fontWeight: s.isSpecial || s.isCurrent ? 600 : 400 }}>
                            <div style={{ fontSize: 12, color: s.isSpecial ? "#10b981" : s.isCurrent ? "#0ea5e9" : "#e2e8f0" }}>
                              ${fmt(s.price, s.price > 100 ? 2 : 4)}
                            </div>
                            <div style={{ fontSize: 9, color: s.isSpecial ? "#10b981" : s.isCurrent ? "#0ea5e9" : "#4b5563" }}>
                              {s.label}
                            </div>
                          </td>
                          <td style={{ ...S.td, textAlign: "right", color: s.longPnL >= 0 ? "#34d399" : "#f87171" }}>
                            {fmtS(s.longPnL)}
                          </td>
                          <td style={{ ...S.td, textAlign: "right", color: s.shortPnL >= 0 ? "#34d399" : "#f87171" }}>
                            {fmtS(s.shortPnL)}
                          </td>
                          <td style={{ ...S.td, textAlign: "right", color: "#f59e0b" }}>
                            -{fmt(s.closeFee + pair.entryFees)}
                          </td>
                          <td style={{ ...S.td, textAlign: "right", fontWeight: 600, color: s.netAll >= 0 ? "#34d399" : "#f87171" }}>
                            {fmtS(s.netAll)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </>
        )}

        {/* ④ DCA SECTION */}
        {selId && selPos && (
          <>
            <Sec label={`물타기 — ${selPos.coin} ${selPos.dir === "long" ? "롱" : "숏"}`} accent />

            <div style={S.modeRow}>
              {[["sim", "추가 진입"], ["reverse", "목표 평단"], ["close", "부분 청산"]].map(([k, lb]) => (
                <button key={k} onClick={() => setDcaMode(k)} style={{
                  ...S.modeBtn,
                  background: dcaMode === k ? (k === "close" ? "#f8717115" : "#0ea5e915") : "transparent",
                  borderColor: dcaMode === k ? (k === "close" ? "#f8717144" : "#0ea5e944") : "#1e1e2e",
                  color: dcaMode === k ? (k === "close" ? "#f87171" : "#0ea5e9") : "#6b7280",
                }}>{lb}</button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 10, fontFamily: "'DM Sans'" }}>
              {dcaMode === "sim" && "지정 가격에 추가 매수하면 평단·청산가·ROE가 어떻게 바뀌는지 미리 확인"}
              {dcaMode === "reverse" && "원하는 평단가를 입력하면 필요한 마진/가격을 역으로 계산"}
              {dcaMode === "close" && "지정 비율만큼 포지션을 줄였을 때의 손익과 잔여 포지션 확인"}
            </div>

            {dcaMode === "sim" && (
              <>
                {/* Direct input — always visible */}
                {dcaEntries.map((dca, idx) => (
                  <div key={dca.id} style={S.dcaRow}>
                    <div style={S.dcaNum}>{idx + 1}</div>
                    <div style={{ flex: 1 }}>
                      <PriceInp value={dca.price} onChange={(v) => updDCA(dca.id, "price", v)} ph="진입 예정가 ($)"
                        cp={selPos ? getCp(selPos.coin) : 0} mode={selPos?.dir === "long" ? "dca-long" : "dca-short"} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Inp value={dca.margin} onChange={(v) => updDCA(dca.id, "margin", v)} ph="투입금액 (USDT)" />
                      {calc && <MarginPresets freeMargin={calc.freeMargin} onSelect={(v) => updDCA(dca.id, "margin", v)} />}
                    </div>
                    {dcaEntries.length > 1 && (
                      <button onClick={() => rmDCA(dca.id)} style={S.rmSm}>×</button>
                    )}
                  </div>
                ))}
                <button onClick={addDCA} style={S.addBtn}>+ 물타기 추가</button>

                {/* Split helper — collapsible */}
                <button onClick={openSplitHelper} style={S.splitToggle}>
                  {splitMode ? "분할 매수 전략 접기 ▲" : "분할 매수 전략 ▼"}
                </button>

                {splitMode && (
                  <div style={S.splitPanel}>
                    <Fld label="총 투입금액 (USDT)">
                      <Inp value={splitTotal} onChange={setSplitTotal} ph="300" />
                      {calc && <MarginPresets freeMargin={calc.freeMargin} onSelect={setSplitTotal} />}
                    </Fld>

                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontFamily: "'DM Sans'" }}>물타기 가격</div>
                      {splitPrices.map((sp, idx) => (
                        <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                          <div style={{ ...S.dcaNum, width: 20, height: 20, fontSize: 10 }}>{idx + 1}</div>
                          <div style={{ flex: 1 }}>
                            <PriceInp value={sp} onChange={(v) => updSplitPrice(idx, v)} ph={`가격 ${idx + 1}`}
                              cp={selPos ? getCp(selPos.coin) : 0} mode={selPos?.dir === "long" ? "dca-long" : "dca-short"} />
                          </div>
                          {splitPrices.length > 2 && (
                            <button onClick={() => rmSplitPrice(idx)} style={{ ...S.rmSm, width: 28, height: 32, fontSize: 14 }}>×</button>
                          )}
                        </div>
                      ))}
                      <button onClick={addSplitPrice} style={{ ...S.addBtn, marginTop: 2, fontSize: 11, padding: "6px 0" }}>+ 가격 추가</button>
                      <SplitAutoGen cp={selPos ? getCp(selPos.coin) : 0} isLong={selPos?.dir === "long"} onGenerate={setSplitPrices} />
                    </div>

                    {calc?.splitResult && (
                      <>
                        <div style={{ height: 12 }} />

                        {calc.splitResult.marginInsufficient && (
                          <div style={{ ...S.warnBox, marginBottom: 8, fontSize: 11 }}>
                            ⚠ 사용 가능({fmt(calc.freeMargin)}) &lt; 총 투입({fmt(calc.splitResult.totalMargin)}) USDT
                          </div>
                        )}

                        {/* Strategy cards */}
                        <div style={S.splitGrid}>
                          {calc.splitResult.results.map((sr, i) => {
                            const isBest = i === calc.splitResult.bestIdx;
                            return (
                              <div key={i} style={{
                                ...S.splitCard,
                                borderColor: isBest ? "#0ea5e944" : "#1e1e2e",
                                background: isBest ? "#0a1020" : "#0a0a14",
                              }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: isBest ? "#0ea5e9" : "#94a3b8", fontFamily: "'DM Sans'" }}>
                                    {isBest ? "✦ " : ""}{sr.name}
                                  </div>
                                  <div style={{ fontSize: 9, color: "#4b5563" }}>{sr.desc}</div>
                                </div>

                                <div style={{ marginBottom: 8 }}>
                                  {sr.entries.map((e, j) => (
                                    <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7280", padding: "2px 0" }}>
                                      <span>${fmt(e.price, 0)}</span>
                                      <span>{fmt(e.margin, 0)} USDT</span>
                                    </div>
                                  ))}
                                </div>

                                <div style={{ borderTop: "1px solid #1e1e2e", paddingTop: 8, marginBottom: 8 }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                                    <span style={{ color: "#6b7280" }}>새 평단</span>
                                    <span style={{ color: isBest ? "#0ea5e9" : "#e2e8f0", fontWeight: 600 }}>${fmt(sr.newAvg)}</span>
                                  </div>
                                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                                    <span style={{ color: "#6b7280" }}>탈출가</span>
                                    <span style={{ color: "#f59e0b" }}>${fmt(sr.breakeven)}</span>
                                  </div>
                                  {calc?.exLiq > 0 && sr.afterLiq != null && (
                                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                                      <span style={{ color: "#6b7280" }}>청산가</span>
                                      <span style={{ color: "#e2e8f0" }}>${fmt(sr.afterLiq)}</span>
                                    </div>
                                  )}
                                </div>

                                <button onClick={() => {
                                  const newEntries = sr.entries.map((e) => ({
                                    id: uid(),
                                    price: String(e.price),
                                    margin: String(Math.round(e.margin * 100) / 100),
                                  }));
                                  setDcaEntries(newEntries);
                                }} style={{
                                  ...S.applyBtn,
                                  width: "100%", padding: "6px 0", textAlign: "center",
                                  background: isBest ? "#0ea5e918" : "#0ea5e908",
                                }}>채우기</button>
                              </div>
                            );
                          })}
                        </div>

                        <div style={{ fontSize: 10, color: "#4b5563", marginTop: 6 }}>
                          ✦ 추천: {calc.splitResult.results[calc.splitResult.bestIdx].name} — 평단이 가장 {calc.sel?.dir === "long" ? "낮아짐" : "높아짐"}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}

            {dcaMode === "reverse" && (
              <div style={S.grid2}>
                <Fld label="물타기 진입 예정가 ($)">
                  <PriceInp value={revPrice} onChange={setRevPrice} ph="예: 2700"
                    cp={selPos ? getCp(selPos.coin) : 0} mode={selPos?.dir === "long" ? "dca-long" : "dca-short"} />
                </Fld>
                <Fld label="목표 평단가 ($)">
                  <Inp value={revTarget} onChange={setRevTarget} ph="예: 3000" />
                </Fld>
              </div>
            )}

            {dcaMode === "close" && (
              <>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, fontFamily: "'DM Sans'" }}>손절 비율</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[25, 50, 75, 100].map((v) => (
                      <button key={v} onClick={() => setCloseRatio(String(v))} style={{
                        flex: 1, padding: "9px 0", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer",
                        border: `1px solid ${n(closeRatio) === v ? "#f8717133" : "#1e1e2e"}`,
                        background: n(closeRatio) === v ? "#f8717112" : "transparent",
                        color: n(closeRatio) === v ? "#f87171" : "#4b5563",
                        fontFamily: "'DM Sans'",
                      }}>{v}%</button>
                    ))}
                  </div>
                </div>
                <div style={S.grid2}>
                  <Fld label="손절 비율 직접 입력 (%)">
                    <Inp value={closeRatio} onChange={setCloseRatio} ph="50" />
                  </Fld>
                  <Fld label="손절 예정가 ($ · 비워두면 현재가)">
                    <PriceInp value={closePrice} onChange={setClosePrice} ph="현재가 기준"
                      cp={selPos ? getCp(selPos.coin) : 0} mode="close" />
                  </Fld>
                </div>
              </>
            )}
          </>
        )}

        {!selId && !pyraMode && (
          <div style={S.empty}>↑ 포지션 카드에서 [물타기] 버튼을 눌러 추가 진입 · 목표 평단 · 부분 청산을 계산하세요</div>
        )}

        {/* ═══ ④-B PYRAMIDING SECTION ═══ */}
        {pyraMode && calc?.pyraCounter && (() => {
          const counter = calc.pyraCounter; // 수익 포지션 (불타기 대상)
          const locked = calc.pyraLocked;   // 물린 포지션 (잠금) — 있을수도 없을수도
          const counterPos = positions.find((p) => p.id === pyraCounterId);
          const counterDirKr = counter.dir === "long" ? "롱" : "숏";
          const lockedDirKr = counter.dir === "long" ? "숏" : "롱";
          const lockedDirEn = counter.dir === "long" ? "short" : "long";

          return (
            <>
              <Sec label={`🔥 불타기 — ${counterPos?.coin || ""} ${counterDirKr} ↔ ${lockedDirKr} (잠금)`} pyra />

              {/* Locked (losing) position selection if not auto-detected */}
              {!pyraLockedId && (() => {
                const candidates = positions.filter((p) => p.id !== pyraCounterId && p.dir === lockedDirEn && p.coin === (counterPos?.coin || ""));
                if (candidates.length > 1) return (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>물린 포지션 선택:</div>
                    {candidates.map((c) => (
                      <button key={c.id} onClick={() => setPyraLockedId(c.id)} style={{
                        ...S.miniBtn, marginRight: 6, marginBottom: 4,
                        color: "#6b7280", borderColor: "#6b728044",
                      }}>
                        {c.dir === "long" ? "롱" : "숏"} ${c.entryPrice} · {c.margin} USDT
                      </button>
                    ))}
                  </div>
                );
                if (candidates.length === 0) return (
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 12, padding: 10, borderRadius: 8, background: "#0a0a12", border: "1px dashed #1e1e2e" }}>
                    반대 방향({lockedDirKr}) 포지션이 없습니다. 포지션을 추가하거나 불타기 진입만 시뮬레이션합니다.
                  </div>
                );
                return null;
              })()}

              {/* Show locked (losing) position info */}
              {locked && (
                <div style={{ padding: 10, borderRadius: 8, background: "#0a0a12", border: "1px solid #1e1e2e", marginBottom: 12, fontSize: 12 }}>
                  <div style={{ color: "#6b7280", fontSize: 10, marginBottom: 4 }}>🔒 물린 포지션 (고정)</div>
                  <span style={{ color: "#94a3b8" }}>
                    {lockedDirKr} · 균일가 ${fmt(locked.ep)} · 마진 {fmt(locked.mg)} · PnL{" "}
                    <span style={{ color: locked.pnl >= 0 ? "#34d399" : "#f87171" }}>
                      {fmtS(locked.pnl)} ({fmtS(locked.roe)}%)
                    </span>
                  </span>
                </div>
              )}

              {/* Sub-mode tabs */}
              <div style={S.modeRow}>
                {[["sim", "추가 진입"], ["reverse", "목표 역전가"]].map(([k, lb]) => (
                  <button key={k} onClick={() => setPyraSubMode(k)} style={{
                    ...S.modeBtn,
                    background: pyraSubMode === k ? "#f59e0b15" : "transparent",
                    borderColor: pyraSubMode === k ? "#f59e0b44" : "#1e1e2e",
                    color: pyraSubMode === k ? "#f59e0b" : "#6b7280",
                  }}>{lb}</button>
                ))}
              </div>

              {pyraSubMode === "sim" && (
                <>
                  {/* Direct input */}
                  {pyraEntries.map((entry, idx) => (
                    <div key={entry.id} style={S.dcaRow}>
                      <div style={{ ...S.dcaNum, background: "#f59e0b15", borderColor: "#f59e0b33", color: "#f59e0b" }}>
                        {calc.pyraCounter ? idx + 1 : idx === 0 ? "①" : idx}
                      </div>
                      <div style={{ flex: 1 }}>
                        <PriceInp value={entry.price} onChange={(v) => updPyra(entry.id, "price", v)} ph={`${counterDirKr} 진입가 ($)`}
                          cp={counterPos ? getCp(counterPos.coin) : 0}
                          mode={counter.dir === "long" ? "pyra-long" : "pyra-short"} accentColor="#f59e0b" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Inp value={entry.margin} onChange={(v) => updPyra(entry.id, "margin", v)} ph="투입금액 (USDT)" />
                        {calc && <MarginPresets freeMargin={calc.freeMargin} onSelect={(v) => updPyra(entry.id, "margin", v)} accentColor="#f59e0b" />}
                      </div>
                      {pyraEntries.length > 1 && (
                        <button onClick={() => rmPyra(entry.id)} style={S.rmSm}>×</button>
                      )}
                    </div>
                  ))}
                  <button onClick={addPyra} style={{ ...S.addBtn, borderColor: "#f59e0b33", color: "#f59e0b66" }}>+ 불타기 추가</button>

                  {/* Split helper */}
                  <button onClick={openPyraSplitHelper} style={{ ...S.splitToggle, borderColor: "#f59e0b33", color: "#f59e0b66" }}>
                    {pyraSplitMode ? "분할 매수 전략 접기 ▲" : "분할 매수 전략 ▼"}
                  </button>

                  {pyraSplitMode && (
                    <div style={{ ...S.splitPanel, borderColor: "#f59e0b22" }}>
                      <Fld label="총 투입금액 (USDT)">
                        <Inp value={pyraSplitTotal} onChange={setPyraSplitTotal} ph="300" />
                        {calc && <MarginPresets freeMargin={calc.freeMargin} onSelect={setPyraSplitTotal} accentColor="#f59e0b" />}
                      </Fld>
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontFamily: "'DM Sans'" }}>불타기 가격</div>
                        {pyraSplitPrices.map((sp, idx) => (
                          <div key={idx} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                            <div style={{ ...S.dcaNum, width: 20, height: 20, fontSize: 10, background: "#f59e0b15", borderColor: "#f59e0b33", color: "#f59e0b" }}>{idx + 1}</div>
                            <div style={{ flex: 1 }}>
                              <PriceInp value={sp} onChange={(v) => updPyraSplitPrice(idx, v)} ph={`가격 ${idx + 1}`}
                                cp={counterPos ? getCp(counterPos.coin) : 0}
                                mode={counter.dir === "long" ? "pyra-long" : "pyra-short"} accentColor="#f59e0b" />
                            </div>
                            {pyraSplitPrices.length > 2 && (
                              <button onClick={() => rmPyraSplitPrice(idx)} style={{ ...S.rmSm, width: 28, height: 32, fontSize: 14 }}>×</button>
                            )}
                          </div>
                        ))}
                        <button onClick={addPyraSplitPrice} style={{ ...S.addBtn, marginTop: 2, fontSize: 11, padding: "6px 0", borderColor: "#f59e0b33", color: "#f59e0b66" }}>+ 가격 추가</button>
                        <SplitAutoGen cp={counterPos ? getCp(counterPos.coin) : 0} isLong={counter.dir === "long"} onGenerate={setPyraSplitPrices} accentColor="#f59e0b" />
                      </div>

                      {calc?.pyraSplitResult && (
                        <>
                          <div style={{ height: 12 }} />
                          {calc.pyraSplitResult.marginInsufficient && (
                            <div style={{ ...S.warnBox, marginBottom: 8, fontSize: 11 }}>
                              ⚠ 사용 가능({fmt(calc.freeMargin)}) &lt; 총 투입({fmt(calc.pyraSplitResult.totalMargin)}) USDT
                            </div>
                          )}
                          <div style={S.splitGrid}>
                            {calc.pyraSplitResult.results.map((sr, i) => (
                              <div key={i} style={{
                                ...S.splitCard,
                                borderColor: i === 0 ? "#f59e0b44" : "#1e1e2e",
                              }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: i === 0 ? "#f59e0b" : "#94a3b8", fontFamily: "'DM Sans'" }}>
                                    {sr.name}
                                  </div>
                                  <div style={{ fontSize: 9, color: sr.desc.includes("⚠") ? "#f87171" : "#4b5563" }}>{sr.desc}</div>
                                </div>
                                <div style={{ marginBottom: 8 }}>
                                  {sr.entries.map((e, j) => (
                                    <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7280", padding: "2px 0" }}>
                                      <span>${fmt(e.price, 0)}</span>
                                      <span>{fmt(e.margin, 0)} USDT</span>
                                    </div>
                                  ))}
                                </div>
                                <button onClick={() => {
                                  const newEntries = sr.entries.map((e) => ({
                                    id: uid(),
                                    price: String(e.price),
                                    margin: String(Math.round(e.margin * 100) / 100),
                                  }));
                                  setPyraEntries(newEntries);
                                }} style={{
                                  ...S.applyBtn,
                                  width: "100%", padding: "6px 0", textAlign: "center",
                                  borderColor: "#f59e0b33", background: "#f59e0b10", color: "#f59e0b",
                                }}>채우기</button>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

              {pyraSubMode === "reverse" && (
                <div style={S.grid2}>
                  <Fld label={`${counterDirKr} 불타기 진입 예정가 ($)`}>
                    <PriceInp value={pyraRevPrice} onChange={setPyraRevPrice} ph="불타기 진입가"
                      cp={counterPos ? getCp(counterPos.coin) : 0}
                      mode={counter.dir === "long" ? "pyra-long" : "pyra-short"} accentColor="#f59e0b" />
                  </Fld>
                  <Fld label="목표 역전가 ($)">
                    <Inp value={pyraRevTarget} onChange={setPyraRevTarget} ph="이 가격에서 합산PnL=0" />
                  </Fld>
                </div>
              )}
            </>
          );
        })()}

        {/* ═══ ⑤-B PYRAMIDING RESULTS ═══ */}
        {calc?.pyraResult && calc.cp > 0 && (() => {
          const pr = calc.pyraResult;
          const hasExLiq = calc?.exLiq > 0;

          return (
            <>
              <div style={{ ...S.divider, background: "linear-gradient(90deg, transparent, #f59e0b22, transparent)" }} />
              <Sec label="불타기 시뮬레이션 결과" pyra />

              {/* Warnings */}
              {pr.warnings.map((w, i) => (
                <div key={i} style={S.warnBox}>⚠ {w.message}</div>
              ))}

              {/* 역전가 프로그레스 */}
              {pr.reversalPrice && (
                <div style={{ ...S.card, borderColor: "#f59e0b33", marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: "#f59e0b", letterSpacing: 2, fontFamily: "'DM Sans'" }}>
                      본전 회복 가격
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#f59e0b", fontFamily: "'IBM Plex Mono'" }}>
                      ${fmt(pr.reversalPrice)}
                    </div>
                  </div>
                  <div style={{ height: 8, background: "#1e1e2e", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", borderRadius: 4, transition: "width 0.3s",
                      width: `${Math.max((pr.reversalProgress || 0) * 100, 0)}%`,
                      background: (pr.reversalProgress || 0) >= 1 ? "#34d399" : "linear-gradient(90deg, #f59e0b, #34d399)",
                    }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: 4, color: "#4b5563" }}>
                    <span>현재가서 {fmtS(pr.reversalDist)}%</span>
                    <span style={{ color: (pr.reversalProgress || 0) >= 1 ? "#34d399" : "#f59e0b" }}>
                      {(pr.reversalProgress || 0) >= 1 ? "🎉 역전 달성!" : `${fmt((pr.reversalProgress || 0) * 100, 0)}%`}
                    </span>
                  </div>
                </div>
              )}

              {/* 청산 시나리오 비교 */}
              {pr.closeScenarios && (
                <div style={{ ...S.card, borderColor: "#1e1e2e", marginBottom: 12 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                    지금 청산하면?
                  </div>
                  {[pr.closeScenarios.both, pr.closeScenarios.counterOnly, pr.closeScenarios.lockedOnly].map((sc, i) => (
                    <div key={i} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "10px 12px", marginBottom: 4, borderRadius: 8,
                      background: i === 0 ? (sc.net >= 0 ? "#34d39908" : "#f8717108") : "#0a0a14",
                      border: `1px solid ${i === 0 ? (sc.net >= 0 ? "#34d39922" : "#f8717122") : "#1e1e2e"}`,
                    }}>
                      <div>
                        <div style={{ fontSize: 12, color: "#e2e8f0", fontWeight: i === 0 ? 600 : 400 }}>{sc.label}</div>
                        <div style={{ fontSize: 10, color: "#4b5563", marginTop: 2 }}>수수료 -{fmt(sc.fee)}</div>
                      </div>
                      <div style={{
                        fontSize: i === 0 ? 15 : 13, fontWeight: 700,
                        color: sc.net >= 0 ? "#34d399" : "#f87171",
                        fontFamily: "'IBM Plex Mono'",
                      }}>
                        {fmtS(sc.net)} USDT
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 합산 PnL + 청산가 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                <HLCard label="현재 합산 PnL"
                  value={`${fmtS(pr.combinedPnL)} USDT`}
                  delta={`물린 ${fmtS(pr.locked?.pnl || 0)} / 반대 ${fmtS(pr.combinedPnL - (pr.locked?.pnl || 0))}`}
                  deltaColor={pr.combinedPnL >= 0 ? "#34d399" : "#f87171"} />
                {hasExLiq && pr.newLiqPrice != null ? (
                  <HLCard label="새 청산가 (추정)"
                    value={`$${fmt(pr.newLiqPrice)}`}
                    delta={pr.newLiqDist != null ? `여유 ${fmt(Math.abs(pr.newLiqDist))}%${pr.liqBefore ? ` (기존 $${fmt(pr.liqBefore)})` : ""}` : null}
                    deltaColor={Math.abs(pr.newLiqDist || 0) < 15 ? "#f87171" : "#34d399"} />
                ) : (
                  <HLCard label="기존 청산가"
                    value={pr.liqBefore ? `$${fmt(pr.liqBefore)}` : "—"}
                    delta={pr.liqDistBefore != null ? `${fmt(Math.abs(pr.liqDistBefore))}% 여유` : null}
                    deltaColor="#6b7280" />
                )}
              </div>

              {/* Stage-by-stage table */}
              {pr.stages.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#f59e0b", fontFamily: "'DM Sans'", marginBottom: 8 }}>
                    진입 단계별 역전가 변화
                  </div>
                  <div style={S.tblWrap}>
                    <table style={S.tbl}>
                      <thead>
                        <tr>
                          <TH>단계</TH><TH>마진</TH><TH>누적</TH>
                          <TH>역전가</TH>
                          {hasExLiq && <><TH>청산가</TH><TH>여유</TH></>}
                        </tr>
                      </thead>
                      <tbody>
                        {pr.stages.map((st, i) => (
                          <tr key={i} style={i === pr.stages.length - 1 ? { background: "#0c0c18" } : {}}>
                            <TD c={i === pr.stages.length - 1 ? "#f59e0b" : "#94a3b8"}>{st.label}</TD>
                            <TD>{fmt(st.margin, 0)}</TD>
                            <TD c="#e2e8f0">{fmt(st.cumMargin, 0)}</TD>
                            <TD c="#f59e0b">{st.reversalPrice ? `$${fmt(st.reversalPrice)}` : "—"}</TD>
                            {hasExLiq && (
                              <>
                                <TD>{st.liqPrice ? `$${fmt(st.liqPrice)}` : "—"}</TD>
                                <TD c={st.liqDist != null && Math.abs(st.liqDist) < 15 ? "#f87171" : "#34d399"}>
                                  {st.liqDist != null ? `${fmt(Math.abs(st.liqDist))}%` : "—"}
                                </TD>
                              </>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Visual: reversal price approaching */}
                  {pr.stages.length > 1 && calc.cp > 0 && (() => {
                    const validStages = pr.stages.filter((s) => s.reversalPrice != null);
                    if (validStages.length < 2) return null;
                    const allPrices = [calc.cp, ...validStages.map((s) => s.reversalPrice)];
                    if (pr.liqBefore) allPrices.push(pr.liqBefore);
                    const minP = Math.min(...allPrices) * 0.98;
                    const maxP = Math.max(...allPrices) * 1.02;
                    const range = maxP - minP;
                    if (range <= 0) return null;
                    const pctOf = (p) => ((p - minP) / range) * 100;

                    return (
                      <div style={{ padding: 16, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e", marginTop: 8, marginBottom: 12 }}>
                        <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 12 }}>역전가 접근 시각화</div>
                        <div style={{ position: "relative", height: validStages.length * 28 + 20 }}>
                          {/* Current price line */}
                          <div style={{
                            position: "absolute", left: `${pctOf(calc.cp)}%`, top: 0, bottom: 0,
                            width: 1, background: "#4b5563", zIndex: 1,
                          }} />
                          <div style={{
                            position: "absolute", left: `${pctOf(calc.cp)}%`, top: -2,
                            transform: "translateX(-50%)", fontSize: 9, color: "#6b7280", whiteSpace: "nowrap",
                          }}>현재가</div>

                          {/* Liq price line */}
                          {pr.liqBefore && (
                            <>
                              <div style={{
                                position: "absolute", left: `${pctOf(pr.liqBefore)}%`, top: 0, bottom: 0,
                                width: 1, background: "#f8717144", zIndex: 1,
                              }} />
                              <div style={{
                                position: "absolute", left: `${pctOf(pr.liqBefore)}%`, bottom: -2,
                                transform: "translateX(-50%)", fontSize: 8, color: "#f8717188", whiteSpace: "nowrap",
                              }}>청산</div>
                            </>
                          )}

                          {/* Stage bars */}
                          {validStages.map((st, i) => {
                            const left = Math.min(pctOf(calc.cp), pctOf(st.reversalPrice));
                            const right = Math.max(pctOf(calc.cp), pctOf(st.reversalPrice));
                            return (
                              <div key={i} style={{
                                position: "absolute", top: 14 + i * 28, left: `${left}%`, width: `${right - left}%`,
                                height: 16, borderRadius: 3,
                                background: `linear-gradient(90deg, #f59e0b22, #f59e0b${Math.min(20 + i * 15, 60).toString(16)})`,
                                border: "1px solid #f59e0b33",
                                display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 4,
                              }}>
                                <span style={{ fontSize: 9, color: "#f59e0b", whiteSpace: "nowrap" }}>
                                  {st.label}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}

              {/* Simultaneous close scenarios table */}
              {pr.scenarios.length > 0 && (
                <div style={S.exitBox}>
                  <div style={{ ...S.exitTitle, color: "#f59e0b" }}>동시 청산 시나리오</div>
                  <div style={{ fontSize: 11, color: "#4b5563", marginBottom: 12 }}>
                    다양한 가격에서 양 포지션 동시 청산 시 결과
                  </div>
                  <div style={S.tblWrap}>
                    <table style={S.tbl}>
                      <thead>
                        <tr>
                          <TH>가격</TH>
                          <TH>물린 PnL</TH>
                          <TH>반대 PnL</TH>
                          <TH>수수료</TH>
                          <TH>순손익</TH>
                        </tr>
                      </thead>
                      <tbody>
                        {pr.scenarios.map((sc, i) => {
                          const isReversal = sc.label === "역전가";
                          const isCurrent = sc.label === "현재가";
                          return (
                            <tr key={i} style={{
                              background: isReversal ? "#f59e0b08" : isCurrent ? "#0c0c18" : "transparent",
                            }}>
                              <TD c={isReversal ? "#f59e0b" : isCurrent ? "#e2e8f0" : "#94a3b8"}>
                                <div>{sc.label}</div>
                                <div style={{ fontSize: 10, color: "#4b5563" }}>${fmt(sc.price)}</div>
                              </TD>
                              <TD c={sc.lockedPnL >= 0 ? "#34d399" : "#f87171"}>{fmtS(sc.lockedPnL, 0)}</TD>
                              <TD c={sc.counterPnL >= 0 ? "#34d399" : "#f87171"}>{fmtS(sc.counterPnL, 0)}</TD>
                              <TD c="#6b7280">-{fmt(sc.fee, 0)}</TD>
                              <TD c={sc.net >= 0 ? "#34d399" : "#f87171"} bold>
                                {fmtS(sc.net, 0)}
                              </TD>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Info items */}
              {pr.infos.length > 0 && (
                <div style={S.detBox}>
                  <div style={S.detTitle}>참고</div>
                  {pr.infos.map((info, i) => (
                    <SL key={i} label="ℹ" value={info} />
                  ))}
                </div>
              )}

              {/* 불타기 vs 물타기 비교 */}
              {pr.dcaComparison && pr.pyraList.length > 0 && (
                <div style={{ ...S.card, borderColor: "#6b728033", marginTop: 8 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                    같은 금액({fmt(pr.addTotalMargin, 0)} USDT) 투입 시 비교
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: 0, fontSize: 12 }}>
                    {/* header */}
                    <div style={{ padding: "6px 8px", color: "#4b5563", fontSize: 10 }}></div>
                    <div style={{ padding: "6px 8px", color: "#f59e0b", fontSize: 10, fontWeight: 700, textAlign: "center" }}>🔥 불타기</div>
                    <div style={{ padding: "6px 8px", color: "#0ea5e9", fontSize: 10, fontWeight: 700, textAlign: "center" }}>💧 물타기</div>
                    {/* 본전/역전 가격 */}
                    <div style={{ padding: "6px 8px", color: "#6b7280", fontSize: 10, borderTop: "1px solid #1e1e2e" }}>본전/역전가</div>
                    <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #1e1e2e", color: "#f59e0b", fontWeight: 600 }}>
                      {pr.dcaComparison.pyraReversal ? `$${fmt(pr.dcaComparison.pyraReversal)}` : "—"}
                    </div>
                    <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #1e1e2e", color: "#0ea5e9", fontWeight: 600 }}>
                      ${fmt(pr.dcaComparison.dcaBreakeven)}
                    </div>
                    {/* 청산가 */}
                    {hasExLiq && (<>
                      <div style={{ padding: "6px 8px", color: "#6b7280", fontSize: 10, borderTop: "1px solid #0e0e18" }}>청산가</div>
                      <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #0e0e18", color: "#94a3b8" }}>
                        {pr.dcaComparison.pyraLiq ? `$${fmt(pr.dcaComparison.pyraLiq)}` : "—"}
                      </div>
                      <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #0e0e18", color: "#94a3b8" }}>
                        {pr.dcaComparison.dcaLiq ? `$${fmt(pr.dcaComparison.dcaLiq)}` : "—"}
                      </div>
                    </>)}
                    {/* 특징 */}
                    <div style={{ padding: "6px 8px", color: "#6b7280", fontSize: 10, borderTop: "1px solid #0e0e18" }}>특징</div>
                    <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #0e0e18", fontSize: 10, color: "#4b5563" }}>
                      양방향 헷지 유지
                    </div>
                    <div style={{ padding: "6px 8px", textAlign: "center", borderTop: "1px solid #0e0e18", fontSize: 10, color: "#4b5563" }}>
                      평단 낮추기 집중
                    </div>
                  </div>
                </div>
              )}

              {/* 불타기 적용 원클릭 */}
              {pr.pyraList.length > 0 && (
                <button onClick={() => {
                  // counter 포지션 업데이트
                  const newAvg = pr.counter.avg;
                  const newMargin = pr.counter.margin;
                  updPos(pyraCounterId, "entryPrice", String(Math.round(newAvg * 100) / 100));
                  updPos(pyraCounterId, "margin", String(Math.round(newMargin * 100) / 100));
                  // 진입 목록 초기화
                  setPyraEntries([mkPyra()]);
                }} style={{
                  width: "100%", padding: "14px 0", marginTop: 12, borderRadius: 10,
                  border: "1px solid #f59e0b44",
                  background: "#f59e0b10",
                  color: "#f59e0b",
                  fontSize: 14, fontWeight: 700, cursor: "pointer",
                  fontFamily: "'DM Sans'", letterSpacing: 0.5,
                  transition: "all 0.15s",
                }}>
                  ⚡ 불타기 적용 — 평단 ${fmt(pr.counter.avg)} · 마진 {fmt(pr.counter.margin, 0)}
                </button>
              )}
            </>
          );
        })()}

        {/* ═══ ⑤-B PYRAMIDING REVERSE RESULT ═══ */}
        {calc?.pyraRevResult && (() => {
          const prv = calc.pyraRevResult;
          if (prv.alreadyReversed) return (
            <div style={{ ...S.warnBox, borderColor: "#34d39933", color: "#34d399", background: "#34d39908" }}>
              ✓ 현재 상태에서 이미 해당 가격에 도달하면 손익이 역전됩니다. 추가 불타기 불필요.
            </div>
          );
          if (prv.impossible) return (
            <div style={S.warnBox}>⚠ 이 가격 조합으로는 역전가에 도달할 수 없습니다.</div>
          );
          return (
            <>
              <div style={{ ...S.divider, background: "linear-gradient(90deg, transparent, #f59e0b22, transparent)" }} />
              <Sec label="역계산 결과" pyra />
              <div style={{
                ...S.revHL,
                borderColor: prv.marginInsufficient ? "#f8717144" : "#f59e0b44",
              }}>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>필요 추가 마진</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: prv.marginInsufficient ? "#f87171" : "#f59e0b" }}>
                  {fmt(prv.neededMargin)} USDT
                </div>
                {prv.marginInsufficient && (
                  <div style={{ fontSize: 12, color: "#f87171", marginTop: 8 }}>
                    ⚠ 여유 마진 부족 — {fmt(prv.neededMargin - (calc.freeMargin || 0))} USDT 모자람
                  </div>
                )}
                {prv.feasible && (
                  <div style={{ fontSize: 12, color: "#34d399", marginTop: 8 }}>✓ 여유 마진 내 가능</div>
                )}
              </div>
              <div style={S.detBox}>
                <div style={S.detTitle}>DETAILS</div>
                <SL label="반대 포지션 새 평단" value={prv.counterAvg ? `$${fmt(prv.counterAvg)}` : "—"} />
                <SL label="반대 포지션 총 마진" value={prv.counterMargin ? `${fmt(prv.counterMargin)} USDT` : "—"} />
                {prv.liqPrice != null && (
                  <SL label="새 청산가 (추정)" value={`$${fmt(prv.liqPrice)}`}
                    warn={prv.liqDist != null && Math.abs(prv.liqDist) < 15} />
                )}
                {prv.liqDist != null && (
                  <SL label="청산 여유" value={`${fmt(Math.abs(prv.liqDist))}%`}
                    warn={Math.abs(prv.liqDist) < 15} />
                )}
              </div>
            </>
          );
        })()}

        {/* ⑤ RESULTS — Simulation */}
        {calc?.dcaResult && (() => {
          const r = calc.dcaResult;
          const isLong = calc.sel.dir === "long";
          return <ResultBlock r={r} isLong={isLong} cp={calc.cp} mode="sim" hasExLiq={calc?.exLiq > 0} />;
        })()}

        {/* ⑤ RESULTS — Reverse */}
        {calc?.revResult && (() => {
          const rv = calc.revResult;
          if (rv.impossible) return (
            <div style={S.warnBox}>
              ⚠ 이 진입가로는 목표 평단에 도달할 수 없습니다.
              {calc.sel.dir === "long"
                ? " 롱 물타기는 현재 평단보다 낮은 가격에 진입해야 평단이 내려갑니다."
                : " 숏 물타기는 현재 평단보다 높은 가격에 진입해야 평단이 올라갑니다."}
            </div>
          );
          const isLong = calc.sel.dir === "long";
          return (
            <>
              <div style={S.divider} />
              <Sec label="역계산 결과" />
              <div style={{
                ...S.revHL,
                borderColor: rv.marginInsufficient ? "#f8717144" : "#0ea5e944",
              }}>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>필요 추가 마진</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: rv.marginInsufficient ? "#f87171" : "#0ea5e9" }}>
                  {fmt(rv.requiredMargin)} USDT
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                  투입 필요: {fmt(rv.requiredInputMargin)} USDT <span style={{ color: "#4b5563" }}>(수수료 {fmt(rv.revFeeDeduct)} 포함)</span>
                </div>
                {rv.marginInsufficient && (
                  <div style={{ fontSize: 12, color: "#f87171", marginTop: 8 }}>
                    ⚠ 여유 마진 부족 — {fmt(rv.requiredMargin - calc.freeMargin)} USDT 모자람
                    {rv.maxReachableAvg != null && (
                      <div style={{ marginTop: 4, color: "#f59e0b" }}>
                        현재 여유 마진으로 도달 가능한 최대 평단: ${fmt(rv.maxReachableAvg)}
                      </div>
                    )}
                  </div>
                )}
                {!rv.marginInsufficient && (
                  <div style={{ fontSize: 12, color: "#34d399", marginTop: 8 }}>✓ 여유 마진 내 가능</div>
                )}
              </div>
              <ResultBlock r={rv} isLong={isLong} cp={calc.cp} mode="reverse" hasExLiq={calc?.exLiq > 0} />
            </>
          );
        })()}

        {/* ⑤ RESULTS — Close (손절) */}
        {calc?.closeResult && (() => {
          const cr = calc.closeResult;
          const isLong = calc.sel.dir === "long";
          const hasExLiq = calc?.exLiq > 0;
          return (
            <>
              <div style={S.divider} />
              <Sec label="손절 결과" />

              {/* Realized PnL highlight */}
              <div style={{
                ...S.revHL,
                borderColor: cr.realizedPnL >= 0 ? "#34d39944" : "#f8717144",
              }}>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>실현 손익</div>
                <div style={{
                  fontSize: 28, fontWeight: 700,
                  color: cr.realizedPnL >= 0 ? "#34d399" : "#f87171",
                }}>
                  {fmtS(cr.realizedPnL)} USDT
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                  마진 {fmt(cr.closedMargin)} 해제 · 수수료 {fmt(cr.closeFee)} USDT
                </div>
              </div>

              {/* Before / After comparison */}
              {calc.cp > 0 && (
                <div style={S.tblWrap}>
                  <table style={S.tbl}>
                    <thead>
                      <tr>
                        <TH />
                        <TH>지갑 잔고</TH><TH>마진</TH>
                        <TH>사용 가능</TH>
                        {hasExLiq && <><TH>청산가</TH><TH>청산여유</TH></>}
                        <TH>미실현 PnL (ROE)</TH>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <TD c="#6b7280">Before</TD>
                        <TD>{fmt(calc.wb)}</TD>
                        <TD>{fmt(calc.sel.mg)}</TD>
                        <TD>{fmt(calc.freeMargin)}</TD>
                        {hasExLiq && (
                          <>
                            <TD>{cr.liqBefore ? `$${fmt(cr.liqBefore)}` : "—"}</TD>
                            <TD>{cr.liqDistBefore != null ? `${fmt(Math.abs(cr.liqDistBefore))}%` : "—"}</TD>
                          </>
                        )}
                        <TD c={calc.sel.pnl >= 0 ? "#34d399" : "#f87171"}>
                          {fmtS(calc.sel.pnl)} ({fmtS(calc.sel.roe)}%)
                        </TD>
                      </tr>
                      <tr style={{ background: "#0c0c18" }}>
                        <TD c="#e2e8f0" bold>After</TD>
                        <TD c="#e2e8f0">{fmt(cr.newWallet)}</TD>
                        <TD c="#e2e8f0">{fmt(cr.remaining.margin)}</TD>
                        <TD c={cr.remFreeMargin > 0 ? "#34d399" : "#f87171"} bold>
                          {fmt(cr.remFreeMargin)}
                        </TD>
                        {hasExLiq && (
                          <>
                            <TD c={cr.remLiq != null ? "#34d399" : "#6b7280"}>
                              {cr.remLiq != null ? `$${fmt(cr.remLiq)}` : "—"}
                            </TD>
                            <TD c="#34d399">
                              {cr.remLiqDist != null ? `${fmt(Math.abs(cr.remLiqDist))}%` : "—"}
                            </TD>
                          </>
                        )}
                        <TD c={cr.remaining.pnl >= 0 ? "#34d399" : "#f87171"} bold>
                          {cr.remaining.qty > 0
                            ? `${fmtS(cr.remaining.pnl)} (${fmtS(cr.remaining.roe)}%)`
                            : "포지션 청산됨"}
                        </TD>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}

              {/* Key metrics */}
              <div style={S.detBox}>
                <div style={S.detTitle}>DETAILS</div>
                <SL label="손절 비율" value={`${cr.ratio * 100}%`} />
                <SL label="손절 가격" value={`$${fmt(cr.closePrice)}`} />
                <SL label="실현 손익" value={`${fmtS(cr.realizedPnL)} USDT`} warn={cr.realizedPnL < 0} />
                <SL label="종료 수수료" value={`${fmt(cr.closeFee)} USDT`} />
                <SL label="새 지갑 잔고" value={`${fmt(cr.newWallet)} USDT`} />
                <SL label="손절 후 사용 가능" value={`${fmt(cr.remFreeMargin)} USDT`} />
              </div>

              {/* Close + DCA scenario */}
              {cr.closeAndDCA && cr.remaining.qty > 0 && (
                <div style={S.cdBox}>
                  <div style={S.cdTitle}>손절 후 물타기 시나리오</div>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 10 }}>
                    남은 포지션에 확보된 {fmt(cr.remFreeMargin, 0)} USDT로
                    ${fmt(cr.closeAndDCA.dcaPrice)}에 물타기 시
                  </div>
                  <div style={S.hlGrid}>
                    <HLCard label="새 평단가" value={`$${fmt(cr.closeAndDCA.newAvg)}`}
                      delta={`기존 대비 ${fmtS(pct(cr.closeAndDCA.newAvg - calc.sel.ep, calc.sel.ep))}%`}
                      deltaColor={(isLong && cr.closeAndDCA.newAvg < calc.sel.ep) || (!isLong && cr.closeAndDCA.newAvg > calc.sel.ep) ? "#34d399" : "#f87171"} />
                    <HLCard label="탈출가" value={`$${fmt(cr.closeAndDCA.breakeven)}`}
                      delta={cr.closeAndDCA.liq != null ? `청산가 $${fmt(cr.closeAndDCA.liq)}` : ""}
                      deltaColor="#f59e0b" />
                  </div>
                  <div style={{ fontSize: 10, color: "#4b5563", marginTop: 4 }}>
                    * 시뮬레이션 모드의 첫 번째 물타기 진입가 기준
                  </div>
                </div>
              )}

              {cr.remaining.qty === 0 && (
                <div style={{ ...S.warnBox, borderColor: "#f59e0b33", color: "#f59e0b", background: "#f59e0b08" }}>
                  100% 손절 시 포지션이 완전히 청산됩니다. 실현 손실이 지갑 잔고에서 차감됩니다.
                </div>
              )}
            </>
          );
        })()}

        <div style={S.footer}>
          교차 마진 · 수수료 왕복 · 펀딩비 미반영
        </div>
        <div style={{ textAlign: "center", padding: "0 20px 16px", fontSize: 8, color: "#2a2a3a", lineHeight: 1.6, fontFamily: "'DM Sans'" }}>
          본 도구는 공개된 수학 공식을 기반으로 한 포지션 계산기이며, 투자 자문·매매 권유·수익 보장의 목적이 아닙니다.<br />
          모든 거래 판단과 책임은 이용자 본인에게 있습니다.
        </div>

        </>)}

        {/* ══════ HEDGE CYCLE TAB ══════ */}
        {appTab === "hedge" && (<>

          {/* HC ① 계좌 & 시장 (자동) */}
          <Sec label="계좌 & 시장" />
          <div style={S.grid2}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontFamily: "'DM Sans'" }}>지갑 총 잔고</div>
              <div style={{ ...S.inp, display: "flex", alignItems: "center", background: "#060d08", borderColor: "#34d39933", cursor: "default" }}>
                <span style={{ color: "#34d399", fontSize: 14, fontWeight: 600, fontFamily: "'IBM Plex Mono'" }}>{fmt(n(wallet), 0)}</span>
                <span style={{ color: "#4b5563", fontSize: 10, marginLeft: 6 }}>USDT</span>
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "'DM Sans'" }}>
                  현재가 — {primaryCoin}/USDT
                </div>
              </div>
              <div style={{ ...S.inp, display: "flex", alignItems: "center", background: "#060d08", borderColor: "#34d39933", cursor: "default" }}>
                <span style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600, fontFamily: "'IBM Plex Mono'" }}>
                  {getCp(primaryCoin) > 0 ? fmt(getCp(primaryCoin), getCp(primaryCoin) > 100 ? 2 : 4) : "—"}
                </span>
              </div>
              <div style={{ fontSize: 9, marginTop: 3, color: priceSourceColor, fontFamily: "'DM Sans'", display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ display: "inline-block", width: 4, height: 4, borderRadius: "50%", background: priceSourceColor }} />
                {priceSourceLabel}
                {coinFundingRates[primaryCoin] && (
                  <span style={{ marginLeft: 6, color: Number(coinFundingRates[primaryCoin]) >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
                    펀딩 {Number(coinFundingRates[primaryCoin]) > 0 ? "+" : ""}{(Number(coinFundingRates[primaryCoin]) * 100).toFixed(4)}%
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* HC ② 전략 파라미터 */}
          <Sec label="전략 파라미터" />
          <div style={S.grid3}>
            <Fld label="기본 마진 (USDT)">
              <Inp value={hcMargin} onChange={setHcMargin} ph="1000" />
            </Fld>
            <Fld label="레버리지">
              <Inp value={hcLeverage} onChange={setHcLeverage} ph="100" />
            </Fld>
            <Fld label="익절 ROE (%)">
              <Inp value={hcTakeROE} onChange={setHcTakeROE} ph="40" />
            </Fld>
          </div>
          <div style={{ ...S.grid3, marginTop: 8 }}>
            <Fld label="손절 비율 (%)">
              <Inp value={hcCutRatio} onChange={setHcCutRatio} ph="50" />
            </Fld>
            <Fld label="복구 ROE (%)">
              <Inp value={hcRecoveryROE} onChange={setHcRecoveryROE} ph="0" />
            </Fld>
            <Fld label="킬 스위치 (%)">
              <Inp value={hcKillPct} onChange={setHcKillPct} ph="15" />
            </Fld>
          </div>

          {/* HC ③ 현재 포지션 입력 */}
          <Sec label="현재 포지션" />
          <div style={S.grid2}>
            <div style={{ ...S.card, borderColor: "#34d39933", background: "#060d08" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#34d399", marginBottom: 8, fontFamily: "'DM Sans'" }}>LONG</div>
              <Fld label="진입가 ($)">
                <Inp value={hcLongEntry} onChange={setHcLongEntry} ph="진입 평단가" />
              </Fld>
              <div style={{ marginTop: 6 }}>
                <Fld label="현재 마진 (USDT)">
                  <Inp value={hcLongMargin} onChange={setHcLongMargin} ph={hcMargin || "1000"} />
                </Fld>
              </div>
              {hcCalc && n(hcLongEntry) > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: hcCalc.longROE >= 0 ? "#34d399" : "#f87171", fontWeight: 600 }}>
                  PnL: {fmtS(hcCalc.longPnL)} ({fmtS(hcCalc.longROE)}%)
                </div>
              )}
            </div>
            <div style={{ ...S.card, borderColor: "#f8717133", background: "#0d0608" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#f87171", marginBottom: 8, fontFamily: "'DM Sans'" }}>SHORT</div>
              <Fld label="진입가 ($)">
                <Inp value={hcShortEntry} onChange={setHcShortEntry} ph="진입 평단가" />
              </Fld>
              <div style={{ marginTop: 6 }}>
                <Fld label="현재 마진 (USDT)">
                  <Inp value={hcShortMargin} onChange={setHcShortMargin} ph={hcMargin || "1000"} />
                </Fld>
              </div>
              {hcCalc && n(hcShortEntry) > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: hcCalc.shortROE >= 0 ? "#34d399" : "#f87171", fontWeight: 600 }}>
                  PnL: {fmtS(hcCalc.shortPnL)} ({fmtS(hcCalc.shortROE)}%)
                </div>
              )}
            </div>
          </div>

          {/* HC ④ 상태 대시보드 */}
          {hcCalc && getCp(primaryCoin) > 0 && (<>
            <Sec label="상태 대시보드" />

            {/* 현재 상태 표시 */}
            <div style={{
              padding: 20, borderRadius: 12, textAlign: "center", marginBottom: 12,
              background: hcCalc.state === 1 ? "#34d39908" : hcCalc.state === 3 ? "#0ea5e908" : "#f59e0b08",
              border: `1px solid ${hcCalc.state === 1 ? "#34d39933" : hcCalc.state === 3 ? "#0ea5e933" : "#f59e0b33"}`,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'DM Sans'", marginBottom: 6,
                color: hcCalc.state === 1 ? "#34d399" : hcCalc.state === 3 ? "#0ea5e9" : "#f59e0b" }}>
                {hcCalc.state === 1 ? "🟢 상태 1 — Balanced (1:1)" :
                 hcCalc.state === 3 ? "🔵 상태 3 — Recovery 가능" :
                 "🟡 상태 2 — Imbalanced"}
              </div>
              <div style={{ fontSize: 11, color: "#6b7280" }}>
                롱 {fmt(hcCalc.longMg, 0)} : 숏 {fmt(hcCalc.shortMg, 0)}
                {!hcCalc.isBalanced && ` (${fmt(hcCalc.ratio, 1)}:1)`}
              </div>
            </div>

            {/* 트리거 프로그레스 */}
            {hcCalc.state === 1 && (
              <div style={{ ...S.card, borderColor: "#1e1e2e" }}>
                <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  익절 트리거 대기
                </div>
                {hcCalc.winner && (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                      <span style={{ color: "#94a3b8" }}>
                        {hcCalc.winner === "long" ? "롱" : "숏"} ROE: {fmtS(hcCalc.winnerROE)}%
                      </span>
                      <span style={{ color: "#0ea5e9" }}>목표: +{hcCalc.takeROE}%</span>
                    </div>
                    <div style={{ height: 8, background: "#1e1e2e", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{
                        height: "100%", borderRadius: 4, transition: "width 0.3s",
                        width: `${Math.max(hcCalc.winnerProgress * 100, 0)}%`,
                        background: hcCalc.winnerProgress >= 1 ? "#34d399" : "linear-gradient(90deg, #0ea5e9, #34d399)",
                      }} />
                    </div>
                    <div style={{ fontSize: 11, color: "#4b5563", marginTop: 6 }}>
                      {hcCalc.winnerProgress >= 1 ? (
                        <span style={{ color: "#34d399", fontWeight: 600 }}>🚨 트리거 도달! 아래 액션을 실행하세요</span>
                      ) : (
                        <>
                          트리거 가격: <span style={{ color: "#e2e8f0" }}>
                            ${fmt(hcCalc.winner === "long" ? hcCalc.longTriggerPrice : hcCalc.shortTriggerPrice)}
                          </span>
                          <span style={{ color: "#4b5563", marginLeft: 6 }}>
                            ({fmtS(((hcCalc.winner === "long" ? hcCalc.longTriggerPrice : hcCalc.shortTriggerPrice) - getCp(primaryCoin)) / getCp(primaryCoin) * 100)}%)
                          </span>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* 복구 프로그레스 (state 2) */}
            {hcCalc.state === 2 && hcCalc.recoveryPrice && (
              <div style={{ ...S.card, borderColor: "#f59e0b33" }}>
                <div style={{ fontSize: 10, color: "#f59e0b", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  복구 대기 — {hcCalc.loser === "long" ? "롱" : "숏"} 본전 복귀 중
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                  <span style={{ color: "#94a3b8" }}>
                    {hcCalc.loser === "long" ? "롱" : "숏"} ROE: {fmtS(hcCalc.loserROE)}%
                  </span>
                  <span style={{ color: "#0ea5e9" }}>목표: {hcCalc.recovROE}%</span>
                </div>
                <div style={{ fontSize: 11, color: "#4b5563", marginTop: 6 }}>
                  복구 가격: <span style={{ color: "#e2e8f0" }}>${fmt(hcCalc.recoveryPrice)}</span>
                  <span style={{ color: "#4b5563", marginLeft: 6 }}>
                    ({fmtS(((hcCalc.recoveryPrice) - getCp(primaryCoin)) / getCp(primaryCoin) * 100)}%)
                  </span>
                </div>
              </div>
            )}

            {/* 액션 체크리스트 */}
            {hcCalc.actions.length > 0 && (
              <div style={{ ...S.card, borderColor: hcCalc.state === 3 ? "#0ea5e933" : "#34d39933" }}>
                <div style={{ fontSize: 10, color: hcCalc.state === 3 ? "#0ea5e9" : "#34d399", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  {hcCalc.state === 3 ? "복구 액션" : "실행할 액션"}
                </div>
                {hcCalc.actions.map((act, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "10px 12px", marginBottom: 4, borderRadius: 8,
                    background: act.type === "profit" ? "#34d39908" : act.type === "loss" ? "#f8717108" : act.type === "recovery" ? "#0ea5e908" : "#0a0a14",
                    border: `1px solid ${act.type === "profit" ? "#34d39922" : act.type === "loss" ? "#f8717122" : act.type === "recovery" ? "#0ea5e922" : "#1e1e2e"}`,
                  }}>
                    <div>
                      <div style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 500 }}>{act.label}</div>
                      <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{act.detail}</div>
                    </div>
                    <div style={{
                      fontSize: 11, fontWeight: 600,
                      color: act.type === "profit" ? "#34d399" : act.type === "loss" ? "#f87171" : "#0ea5e9",
                    }}>
                      {act.type === "profit" ? "익절" : act.type === "loss" ? "손절" : act.type === "entry" ? "진입" : "복구"}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 손익 시뮬레이션 테이블 */}
            {hcCalc.cycleProfit && (
              <div style={{ ...S.card, borderColor: "#0ea5e922" }}>
                <div style={{ fontSize: 10, color: "#0ea5e9", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  사이클 실행 시 예상 손익
                </div>
                {[
                  { label: `${hcCalc.winner === "long" ? "롱" : "숏"} 익절 수익`, value: hcCalc.cycleProfit.winProfit, color: "#34d399", prefix: "+" },
                  { label: "  └ 청산 수수료", value: -hcCalc.cycleProfit.winCloseFee, color: "#f87171", prefix: "" },
                  { label: `${hcCalc.winner === "long" ? "롱" : "숏"} 재진입 수수료`, value: -hcCalc.cycleProfit.reentryFee, color: "#f87171", prefix: "" },
                  { label: `${hcCalc.loser === "long" ? "롱" : "숏"} ${n(hcCutRatio)}% 손절`, value: hcCalc.cycleProfit.loserCutPnL, color: "#f87171", prefix: "" },
                  { label: "  └ 청산 수수료", value: -hcCalc.cycleProfit.loserCutFee, color: "#f87171", prefix: "" },
                ].map((row, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", padding: "4px 0",
                    borderBottom: i < 4 ? "1px solid #0e0e18" : "none", fontSize: 12,
                  }}>
                    <span style={{ color: "#94a3b8" }}>{row.label}</span>
                    <span style={{ color: row.color, fontWeight: 500 }}>
                      {row.prefix}{fmt(row.value)} USDT
                    </span>
                  </div>
                ))}
                <div style={{
                  display: "flex", justifyContent: "space-between", padding: "8px 0 4px",
                  borderTop: "1px solid #1e1e2e", marginTop: 4, fontSize: 13, fontWeight: 700,
                }}>
                  <span style={{ color: "#e2e8f0" }}>순수익</span>
                  <span style={{ color: hcCalc.cycleProfit.netProfit >= 0 ? "#34d399" : "#f87171" }}>
                    {fmtS(hcCalc.cycleProfit.netProfit)} USDT
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", fontSize: 11 }}>
                  <span style={{ color: "#4b5563" }}>발생 거래량</span>
                  <span style={{ color: "#6b7280" }}>{fmt(hcCalc.cycleProfit.totalVolume, 0)} USDT</span>
                </div>
              </div>
            )}

            {/* 알림 가격 가이드 */}
            {hcCalc.alertPrices.length > 0 && (
              <div style={{ ...S.card, borderColor: "#1e1e2e" }}>
                <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  📌 거래소 알림 설정 가이드
                </div>
                {hcCalc.alertPrices.map((ap, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                    background: "#0a0a14", border: "1px solid #1e1e2e",
                  }}>
                    <div>
                      <div style={{ fontSize: 11, color: ap.color, fontWeight: 600 }}>{ap.label}</div>
                      <div style={{ fontSize: 10, color: "#4b5563", marginTop: 2 }}>
                        현재가 대비 {fmtS(((ap.price - getCp(primaryCoin)) / getCp(primaryCoin)) * 100)}%
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0", fontFamily: "'IBM Plex Mono'" }}>
                        ${fmt(ap.price)}
                      </span>
                      <button onClick={() => {
                        try { navigator.clipboard.writeText(String(ap.price.toFixed(2))); } catch (e) {}
                      }} style={{
                        ...S.miniBtn, fontSize: 10, padding: "3px 6px",
                        color: "#4b5563", borderColor: "#1e1e2e",
                      }} title="복사">📋</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 사이클 실행 버튼 */}
            {hcCalc.actions.length > 0 && (
              <button onClick={() => {
                const cp = getCp(primaryCoin);
                if (!cp) return;
                const profit = hcCalc.cycleProfit ? hcCalc.cycleProfit.netProfit : 0;

                if (hcCalc.state === 1 || hcCalc.state === 2) {
                  // State 1→2 또는 State 2→2 (원웨이): 익절+재진입+손절
                  // Winner: 재진입이므로 진입가 = 현재가
                  if (hcCalc.winner === "long") {
                    setHcLongEntry(String(cp));
                    setHcLongMargin(String(hcCalc.baseMg));
                    // Loser(숏): 마진 cutRatio만큼 축소, 진입가 유지
                    setHcShortMargin(String(Math.round(hcCalc.shortMg * (1 - hcCalc.cutRatio) * 100) / 100));
                  } else {
                    setHcShortEntry(String(cp));
                    setHcShortMargin(String(hcCalc.baseMg));
                    setHcLongMargin(String(Math.round(hcCalc.longMg * (1 - hcCalc.cutRatio) * 100) / 100));
                  }
                  // 지갑 잔고 업데이트 (수익 반영)
                  setWallet(String(Math.round((n(wallet) + profit) * 100) / 100));
                  setHcCycles((prev) => [...prev, {
                    profit: Math.round(profit * 100) / 100,
                    note: hcCalc.state === 1 ? "횡보 익절" : "원웨이 익절",
                    ts: Date.now(),
                  }]);
                } else if (hcCalc.state === 3) {
                  // State 3→1: 복구 — loser에 마진 채우기
                  const loserEp = hcCalc.loser === "long" ? hcCalc.longEp : hcCalc.shortEp;
                  const loserMg = hcCalc.loser === "long" ? hcCalc.longMg : hcCalc.shortMg;
                  const fillMg = hcCalc.baseMg - loserMg;
                  // 새 평단 = 조화평균
                  const oldNotional = loserMg * hcCalc.lev;
                  const addNotional = fillMg * hcCalc.lev;
                  const oldQty = loserEp > 0 ? oldNotional / loserEp : 0;
                  const addQty = cp > 0 ? addNotional / cp : 0;
                  const newAvg = (oldNotional + addNotional) / (oldQty + addQty);
                  if (hcCalc.loser === "long") {
                    setHcLongEntry(String(Math.round(newAvg * 100) / 100));
                    setHcLongMargin(String(hcCalc.baseMg));
                  } else {
                    setHcShortEntry(String(Math.round(newAvg * 100) / 100));
                    setHcShortMargin(String(hcCalc.baseMg));
                  }
                  setHcCycles((prev) => [...prev, {
                    profit: 0, note: "복구 완료", ts: Date.now(),
                  }]);
                }
              }} style={{
                width: "100%", padding: "14px 0", marginTop: 8, borderRadius: 10,
                border: `1px solid ${hcCalc.state === 3 ? "#0ea5e944" : "#34d39944"}`,
                background: hcCalc.state === 3 ? "#0ea5e910" : "#34d39910",
                color: hcCalc.state === 3 ? "#0ea5e9" : "#34d399",
                fontSize: 14, fontWeight: 700, cursor: "pointer",
                fontFamily: "'DM Sans'", letterSpacing: 0.5,
                transition: "all 0.15s",
              }}>
                {hcCalc.state === 3 ? "⚡ 복구 실행 (State 3 → 1)" : "⚡ 사이클 실행 (익절 + 손절)"}
              </button>
            )}

            {/* 킬 스위치 */}
            <div style={{
              ...S.card, marginTop: 4,
              borderColor: hcCalc.killAlert ? "#f8717144" : "#1e1e2e",
              background: hcCalc.killAlert ? "#f8717108" : "#08080f",
            }}>
              <div style={{ fontSize: 10, color: hcCalc.killAlert ? "#f87171" : "#6b7280", letterSpacing: 2, marginBottom: 8, fontFamily: "'DM Sans'" }}>
                {hcCalc.killAlert ? "🚨 킬 스위치 발동" : "안전장치"}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                <span style={{ color: "#94a3b8" }}>Equity: {fmt(hcCalc.equity)} USDT</span>
                <span style={{ color: hcCalc.equityPct < 90 ? "#f87171" : "#34d399" }}>{fmt(hcCalc.equityPct, 1)}%</span>
              </div>
              <div style={{ height: 6, background: "#1e1e2e", borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 3,
                  width: `${Math.max(Math.min(hcCalc.equityPct, 100), 0)}%`,
                  background: hcCalc.equityPct > 90 ? "#34d399" : hcCalc.equityPct > 85 ? "#f59e0b" : "#f87171",
                  transition: "width 0.3s",
                }} />
              </div>
              <div style={{ fontSize: 10, color: "#4b5563", marginTop: 4 }}>
                킬 스위치: {fmt(hcCalc.killThreshold)} USDT (-{hcKillPct}%) · 여유: {fmt(hcCalc.equity - hcCalc.killThreshold)} USDT
              </div>
              {hcCalc.killAlert && (
                <div style={{ fontSize: 12, color: "#f87171", fontWeight: 700, marginTop: 8, textAlign: "center" }}>
                  ⚠ 모든 포지션 즉시 청산 권고
                </div>
              )}
            </div>

            {/* 원웨이 시나리오 */}
            {hcCalc.onewayScenario.length > 0 && (
              <div style={{ ...S.card, marginTop: 4 }}>
                <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" }}>
                  원웨이 시나리오 (되돌림 없이 계속 추세)
                </div>
                <div style={S.tblWrap}>
                  <table style={S.tbl}>
                    <thead>
                      <tr>
                        <TH>사이클</TH><TH>Loser 잔여 마진</TH><TH>누적 수익</TH><TH>누적 거래량</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {hcCalc.onewayScenario.map((s) => (
                        <tr key={s.cycle}>
                          <TD c="#e2e8f0">#{s.cycle}</TD>
                          <TD c={s.loserMg < 10 ? "#f87171" : "#94a3b8"}>{fmt(s.loserMg)} USDT</TD>
                          <TD c="#34d399">+{fmt(s.cumProfit)}</TD>
                          <TD c="#94a3b8">{fmt(s.cumVolume, 0)}</TD>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 사이클 히스토리 */}
            {hcCycles.length > 0 && (
              <div style={{ ...S.card, marginTop: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", letterSpacing: 2, fontFamily: "'DM Sans'" }}>
                    사이클 기록
                  </div>
                  <button onClick={() => { if (confirm("사이클 기록을 모두 삭제할까요?")) setHcCycles([]); }}
                    style={{ ...S.miniBtn, fontSize: 9, color: "#f87171" }}>기록 삭제</button>
                </div>
                {hcCycles.map((c, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", padding: "6px 0",
                    borderBottom: "1px solid #0e0e18", fontSize: 12,
                  }}>
                    <span style={{ color: "#6b7280" }}>#{i + 1}</span>
                    <span style={{ color: "#34d399" }}>+{fmt(c.profit)} USDT</span>
                    <span style={{ color: "#4b5563" }}>{c.note || ""}</span>
                  </div>
                ))}
                <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600 }}>
                  <span style={{ color: "#6b7280" }}>누적: </span>
                  <span style={{ color: "#34d399" }}>+{fmt(hcCycles.reduce((a, c) => a + n(c.profit), 0))} USDT</span>
                </div>
              </div>
            )}

          </>)}

          <div style={S.footer}>
            Hedge Cycle Bot · 3-State 순환 · ROE = 미실현손익 / 전략마진
          </div>

        </>)}

          </>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   RESULT BLOCK
   ═══════════════════════════════════════════ */
function ResultBlock({ r, isLong, cp, mode, hasExLiq }) {
  const [customTarget, setCustomTarget] = useState("");
  const b = r.before;
  const a = r.after;
  const liqWorse = r.liqWorse;

  // Exit scenario calculations
  const fr = r.feeRate || 0;
  const calcExit = (targetPnL) => {
    // targetPnL: 수수료 차감 후 실현 PnL
    // Long: (exit - avg) × qty - avg×qty×fee - exit×qty×fee = targetPnL
    //   → exit = (targetPnL + avg×qty×(1+fee)) / (qty×(1-fee))
    // Short: (avg - exit) × qty - avg×qty×fee - exit×qty×fee = targetPnL
    //   → exit = (avg×qty×(1-fee) - targetPnL) / (qty×(1+fee))
    if (a.qty <= 0) return null;
    const exitPrice = isLong
      ? (targetPnL + a.avg * a.qty * (1 + fr)) / (a.qty * (1 - fr))
      : (a.avg * a.qty * (1 - fr) - targetPnL) / (a.qty * (1 + fr));
    if (exitPrice <= 0) return null;
    const changePct = cp > 0 ? ((exitPrice - cp) / cp) * 100 : 0;
    return { exitPrice, changePct, pnl: targetPnL };
  };

  // Presets: breakeven(0), +1%, +3%, +5% of margin
  const presets = [
    { label: "본전 (수수료 포함)", pnl: 0 },
    { label: `+1% 수익`, pnl: a.margin * 0.01 },
    { label: `+3% 수익`, pnl: a.margin * 0.03 },
    { label: `+5% 수익`, pnl: a.margin * 0.05 },
    { label: `+10% 수익`, pnl: a.margin * 0.10 },
  ];

  const customPnL = n(customTarget);
  const customExit = customPnL > 0 ? calcExit(customPnL) : null;

  return (
    <>
      {mode === "sim" && <div style={S.divider} />}
      {mode === "sim" && <Sec label="시뮬레이션 결과" />}
      {mode === "reverse" && <div style={{ height: 12 }} />}

      {/* Highlight cards */}
      <div style={S.hlGrid}>
        <HLCard label="새 평단가" value={`$${fmt(a.avg)}`}
          delta={`${fmtS(pct(a.avg - b.avg, b.avg))}%`}
          deltaColor={(isLong && a.avg < b.avg) || (!isLong && a.avg > b.avg) ? "#34d399" : "#f87171"} />

        {hasExLiq && a.liq != null ? (
          <HLCard label="새 청산가 (추정)" value={`$${fmt(a.liq)}`}
            delta={liqWorse ? "⚠ 위험" : "✓ 안전"}
            deltaColor={liqWorse ? "#f87171" : "#34d399"}
            sub={a.liqDist != null ? `현재가 대비 ${fmt(Math.abs(a.liqDist))}% 여유` : null} />
        ) : (
          <HLCard label="새 청산가" value="—"
            delta="거래소 청산가 입력 필요" deltaColor="#6b7280" />
        )}

        <HLCard label="탈출가 (수수료 포함)" value={`$${fmt(r.breakeven)}`}
          delta={`평단 대비 ${isLong ? "+" : ""}${fmt(Math.abs(r.moveNeeded), 3)}%`}
          deltaColor="#f59e0b" wide />
      </div>

      {/* Before / After table */}
      {cp > 0 && (
        <div style={S.tblWrap}>
          <table style={S.tbl}>
            <thead>
              <tr>
                <TH />
                <TH>균일가</TH><TH>마진</TH>
                {hasExLiq && <><TH>청산가</TH><TH>청산여유</TH></>}
                <TH>미실현 PnL (ROE)</TH>
              </tr>
            </thead>
            <tbody>
              <tr>
                <TD c="#6b7280">Before</TD>
                <TD>${fmt(b.avg)}</TD>
                <TD>{fmt(b.margin)}</TD>
                {hasExLiq && (
                  <>
                    <TD>{b.liq ? `$${fmt(b.liq)}` : "—"}</TD>
                    <TD>{b.liqDist != null ? `${fmt(Math.abs(b.liqDist))}%` : "—"}</TD>
                  </>
                )}
                <TD c={b.pnl >= 0 ? "#34d399" : "#f87171"}>
                  {fmtS(b.pnl)} ({fmtS(b.roe)}%)
                </TD>
              </tr>
              <tr style={{ background: "#0c0c18" }}>
                <TD c="#e2e8f0" bold>After</TD>
                <TD c="#0ea5e9">${fmt(a.avg)}</TD>
                <TD c="#e2e8f0">{fmt(a.margin)}</TD>
                {hasExLiq && (
                  <>
                    <TD c={liqWorse ? "#f87171" : "#34d399"}>
                      {a.liq != null ? `$${fmt(a.liq)}` : "—"}
                    </TD>
                    <TD c={liqWorse ? "#f87171" : "#34d399"}>
                      {a.liqDist != null ? `${fmt(Math.abs(a.liqDist))}%` : "—"}
                    </TD>
                  </>
                )}
                <TD c={a.pnl >= 0 ? "#34d399" : "#f87171"} bold>
                  {fmtS(a.pnl)} ({fmtS(a.roe)}%)
                </TD>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Details */}
      <div style={S.detBox}>
        <div style={S.detTitle}>DETAILS</div>
        {r.addTotalFeeDeduct > 0 && (
          <>
            <SL label="투입 금액" value={`${fmt(r.addTotalRawMargin)} USDT`} />
            <SL label="수수료 예약 (진입+청산)" value={`-${fmt(r.addTotalFeeDeduct)} USDT`} warn />
            <SL label="실제 추가 마진" value={`${fmt(r.addTotalMargin)} USDT`} />
            {r.dcaList && r.dcaList.length > 1 && (
              <div style={{ padding: "6px 0 2px", borderBottom: "1px solid #0e0e18" }}>
                {r.dcaList.map((d, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#4b5563", padding: "2px 0" }}>
                    <span>#{i + 1} ${fmt(d.price)} · {fmt(d.rawMargin, 0)}</span>
                    <span style={{ color: "#f59e0b" }}>수수료 {fmt(d.feeDeduct)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <SL label="예상 수수료 (진입+청산)" value={`${fmt(r.totalFee)} USDT`} />
        <SL label="물타기 후 사용 가능" value={`${fmt(r.afterFreeMargin, 0)} USDT`}
          warn={r.afterFreeMargin < 0} />
        {r.marginInsufficient && <SL label="⚠ 잔고 상태" value="마진 부족" warn />}
        {r.marginInsufficient && r.shortfallInfo && (
          <div style={S.shortfallBox}>
            {r.shortfallInfo.impossible ? (
              <span>현재 포지션 구조에서 마진 확보 불가</span>
            ) : (
              <>
                <div style={{ marginBottom: 4 }}>
                  부족분: <span style={{ color: "#f87171", fontWeight: 600 }}>{fmt(r.shortfallInfo.shortfall)} USDT</span>
                </div>
                <div>
                  <span style={{ color: "#0ea5e9", fontWeight: 600 }}>${fmt(r.shortfallInfo.price)}</span> 도달 시 물타기 가능
                  <span style={{ color: r.shortfallInfo.changePct > 0 ? "#34d399" : "#f87171", marginLeft: 6 }}>
                    (현재가 대비 {fmtS(r.shortfallInfo.changePct)}%)
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {liqWorse && (
        <div style={S.warnBox}>
          ⚠ 물타기 후 청산가가 현재가에 더 가까워졌습니다. 교차 마진에서는 지갑 전체 잔고가 위험에 노출됩니다.
        </div>
      )}

      {/* ── EXIT SCENARIOS ── */}
      {cp > 0 && a.qty > 0 && (
        <div style={S.exitBox}>
          <div style={S.exitTitle}>탈출 시나리오</div>
          <div style={{ fontSize: 11, color: "#4b5563", marginBottom: 12 }}>
            물타기 후 포지션을 청산할 때의 목표별 가격
          </div>
          <div style={S.tblWrap}>
            <table style={S.tbl}>
              <thead>
                <tr>
                  <TH>목표</TH>
                  <TH>탈출가</TH>
                  <TH>현재가 대비</TH>
                  <TH>실현 PnL</TH>
                </tr>
              </thead>
              <tbody>
                {presets.map((p, i) => {
                  const ex = calcExit(p.pnl);
                  if (!ex) return null;
                  return (
                    <tr key={i} style={i === 0 ? { background: "#0c0c18" } : {}}>
                      <TD c={i === 0 ? "#f59e0b" : "#94a3b8"}>{p.label}</TD>
                      <TD c={i === 0 ? "#f59e0b" : "#e2e8f0"}>${fmt(ex.exitPrice)}</TD>
                      <TD c={ex.changePct >= 0 ? "#34d399" : "#f87171"}>
                        {fmtS(ex.changePct)}%
                      </TD>
                      <TD c={ex.pnl >= 0 ? "#34d399" : "#94a3b8"}>
                        {fmtS(ex.pnl)} USDT
                      </TD>
                    </tr>
                  );
                })}
                {customExit && (
                  <tr style={{ background: "#0a1020" }}>
                    <TD c="#0ea5e9">커스텀</TD>
                    <TD c="#0ea5e9">${fmt(customExit.exitPrice)}</TD>
                    <TD c={customExit.changePct >= 0 ? "#34d399" : "#f87171"}>
                      {fmtS(customExit.changePct)}%
                    </TD>
                    <TD c="#0ea5e9">
                      {fmtS(customExit.pnl)} USDT
                    </TD>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={S.exitCustomRow}>
            <span style={{ fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" }}>목표 수익:</span>
            <input type="number" value={customTarget}
              placeholder="직접 입력 (USDT)"
              onChange={(e) => setCustomTarget(e.target.value)}
              style={{ ...S.inp, fontSize: 12, padding: "7px 10px", flex: 1 }}
              onFocus={(e) => (e.target.style.borderColor = "#0ea5e9")}
              onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
            <span style={{ fontSize: 11, color: "#4b5563" }}>USDT</span>
          </div>
        </div>
      )}
    </>
  );
}
/* ═══════════════════════════════════════════
   SUB COMPONENTS
   ═══════════════════════════════════════════ */
function Sec({ label, accent, pyra }) {
  const accentColor = pyra ? "#f59e0b" : "#0ea5e9";
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, letterSpacing: 2.5, textTransform: "uppercase",
      color: (accent || pyra) ? accentColor : "#4b5563", fontFamily: "'DM Sans'",
      margin: "28px 0 10px", display: "flex", alignItems: "center", gap: 8,
    }}>
      {(accent || pyra) && <div style={{ width: 3, height: 14, background: accentColor, borderRadius: 2 }} />}
      {label}
    </div>
  );
}
function Fld({ label, children }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontFamily: "'DM Sans'" }}>{label}</div>
      {children}
    </div>
  );
}
function Inp({ value, onChange, ph }) {
  return (
    <input type="number" value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)}
      style={S.inp}
      onFocus={(e) => (e.target.style.borderColor = "#0ea5e9")}
      onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
  );
}

/* 가격 입력 + 현재가/±% 빠른 버튼 */
function PriceInp({ value, onChange, ph, cp, mode, accentColor }) {
  // mode: "dca" = 물타기(평단 유리 방향), "pyra" = 불타기(추세 방향), "close" = 양방향, "entry" = 양방향
  // accentColor: 버튼 강조색 (기본 #0ea5e9)
  const ac = accentColor || "#0ea5e9";
  const hasCp = cp > 0;
  const pctCalc = (pct) => String(Math.round(cp * (1 + pct / 100) * 100) / 100);

  // 방향별 % 프리셋
  let pctPresets = [];
  if (mode === "dca-long") pctPresets = [{ l: "-1%", v: -1 }, { l: "-3%", v: -3 }, { l: "-5%", v: -5 }];
  else if (mode === "dca-short") pctPresets = [{ l: "+1%", v: 1 }, { l: "+3%", v: 3 }, { l: "+5%", v: 5 }];
  else if (mode === "pyra-long") pctPresets = [{ l: "+1%", v: 1 }, { l: "+3%", v: 3 }, { l: "+5%", v: 5 }];
  else if (mode === "pyra-short") pctPresets = [{ l: "-1%", v: -1 }, { l: "-3%", v: -3 }, { l: "-5%", v: -5 }];
  else pctPresets = [{ l: "-3%", v: -3 }, { l: "-1%", v: -1 }, { l: "+1%", v: 1 }, { l: "+3%", v: 3 }];

  const btnS = { padding: "2px 0", fontSize: 8, fontWeight: 600, borderRadius: 3, cursor: "pointer", border: `1px solid ${ac}22`, background: `${ac}08`, color: `${ac}99`, fontFamily: "'DM Sans'", flex: 1, minWidth: 0, transition: "all 0.12s" };

  return (
    <div>
      <input type="number" value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)}
        style={S.inp}
        onFocus={(e) => (e.target.style.borderColor = ac)}
        onBlur={(e) => (e.target.style.borderColor = "#1e1e2e")} />
      {hasCp && (
        <div style={{ display: "flex", gap: 2, marginTop: 3 }}>
          <button onClick={() => onChange(String(cp))} style={{ ...btnS, background: `${ac}15`, color: ac, fontWeight: 700, fontSize: 9 }}>현재가</button>
          {pctPresets.map((p) => (
            <button key={p.l} onClick={() => onChange(pctCalc(p.v))} style={btnS}>{p.l}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* 마진 빠른 입력 프리셋 */
function MarginPresets({ freeMargin, onSelect, accentColor }) {
  const ac = accentColor || "#0ea5e9";
  if (!freeMargin || freeMargin <= 0) return null;
  const presets = [
    { label: "전액", pct: 100 },
    { label: "50%", pct: 50 },
    { label: "25%", pct: 25 },
    { label: "10%", pct: 10 },
    { label: "5%", pct: 5 },
  ];
  const btnS = { padding: "2px 0", fontSize: 8, fontWeight: 600, borderRadius: 3, cursor: "pointer", border: `1px solid ${ac}22`, background: `${ac}08`, color: `${ac}99`, fontFamily: "'DM Sans'", flex: 1, minWidth: 0, transition: "all 0.12s" };
  return (
    <div>
      <div style={{ display: "flex", gap: 2, marginTop: 3 }}>
        {presets.map((p) => (
          <button key={p.pct} onClick={() => onSelect(String(Math.floor(freeMargin * p.pct / 100 * 100) / 100))} style={btnS}>{p.label}</button>
        ))}
      </div>
      <div style={{ fontSize: 8, color: "#4b5563", marginTop: 2, textAlign: "right", fontFamily: "'DM Sans'" }}>
        여유: {freeMargin.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} USDT
      </div>
    </div>
  );
}

/* 분할 매수 가격 자동 생성 */
function SplitAutoGen({ cp, isLong, onGenerate, accentColor }) {
  const [gap, setGap] = useState("2");
  const [count, setCount] = useState("3");
  const ac = accentColor || "#0ea5e9";
  if (!cp || cp <= 0) return null;

  const generate = () => {
    const g = Number(gap) || 2;
    const c = Math.min(Math.max(Number(count) || 3, 2), 10);
    const sign = isLong ? -1 : 1;
    const prices = Array.from({ length: c }, (_, i) =>
      String(Math.round(cp * (1 + sign * (i + 1) * g / 100) * 100) / 100)
    );
    onGenerate(prices);
  };

  const inputS = { ...S.inp, fontSize: 11, padding: "5px 8px", width: "100%" };
  return (
    <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: "#06060e", border: `1px solid ${ac}15` }}>
      <div style={{ fontSize: 10, color: ac, fontWeight: 600, marginBottom: 6, fontFamily: "'DM Sans'" }}>
        자동 생성 (현재가 ${cp.toLocaleString()} 기준)
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 9, color: "#4b5563", marginBottom: 2 }}>간격 (%)</div>
          <input type="number" value={gap} onChange={(e) => setGap(e.target.value)} style={inputS} placeholder="2" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 9, color: "#4b5563", marginBottom: 2 }}>개수</div>
          <input type="number" value={count} onChange={(e) => setCount(e.target.value)} style={inputS} placeholder="3" />
        </div>
        <button onClick={generate} style={{
          padding: "6px 12px", fontSize: 10, fontWeight: 600, borderRadius: 6,
          border: `1px solid ${ac}44`, background: `${ac}15`, color: ac,
          cursor: "pointer", fontFamily: "'DM Sans'", whiteSpace: "nowrap",
        }}>생성</button>
      </div>
      <div style={{ fontSize: 8, color: "#4b5563", marginTop: 4, fontFamily: "'DM Sans'" }}>
        {isLong ? "▼ 현재가 아래로" : "▲ 현재가 위로"} {gap}% 간격 · {count}개
      </div>
    </div>
  );
}

function InputCalc({ pos, ep, lev, fee, onUpdate }) {
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState("");

  return (
    <div style={{ marginTop: 4 }}>
      <button onClick={() => setOpen(!open)} style={{
        background: "none", border: "none", padding: 0,
        fontSize: 10, color: open ? "#0ea5e9" : "#4b5563",
        cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2,
      }}>
        {open ? "▾ 투입금액 계산기 닫기" : "💰 투입금액으로 계산"}
      </button>
      {open && (
        <div style={{
          marginTop: 4, padding: 8, background: "#06060e",
          borderRadius: 6, border: "1px solid #1e1e2e",
        }}>
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>
            투입금액을 입력하면 수수료를 차감한 표시 마진을 자동 계산합니다
          </div>
          <Inp value={amt} onChange={(v) => {
            setAmt(v);
            if (ep > 0 && n(v) > 0 && lev > 0) {
              const conv = fromInput(n(v), ep, lev, fee, pos.dir, pos.coin);
              if (conv) onUpdate(pos.id, "margin", String(Math.round(conv.margin * 1e6) / 1e6));
            }
          }} ph="실제 넣은 금액 (예: 300)" />
          {ep > 0 && n(amt) > 0 && (() => {
            const conv = fromInput(n(amt), ep, lev, fee, pos.dir, pos.coin);
            if (!conv) return <div style={{ fontSize: 10, color: "#f87171", marginTop: 4 }}>계산 불가 (값 확인)</div>;
            return (
              <div style={{ marginTop: 6, fontSize: 10, color: "#4b5563", lineHeight: 1.6 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>표시 마진</span><span style={{ color: "#cbd5e1" }}>{fmt(conv.margin)} USDT</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>진입 수수료</span><span style={{ color: "#f59e0b" }}>-{fmt(conv.openCost)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>청산 수수료 예약</span><span style={{ color: "#f59e0b" }}>-{fmt(conv.closeCost)}</span>
                </div>
                {conv.change > 0.01 && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>잔돈 (수량 내림)</span><span>{fmt(conv.change)}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between",
                              marginTop: 2, borderTop: "1px solid #1e1e2e", paddingTop: 2 }}>
                  <span>수량</span><span style={{ color: "#cbd5e1" }}>{fmt(conv.qty, 4)} {pos.coin}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 9, color: "#6b728088" }}>
                  ※ 거래소 실제 수량과 소폭 차이가 있을 수 있습니다
                </div>
              </div>
            );
          })()}
          {ep <= 0 && n(amt) > 0 && (
            <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 4 }}>
              진입가를 먼저 입력하세요
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══ HEDGE PANEL (인라인) ═══ */
function HedgePanel({ pos, calc, hedgeEntry, setHedgeEntry, hedgeMargin, setHedgeMargin, hedgeLev, setHedgeLev, hedgeLive, setHedgeLive, getCp }) {
  const hr = calc?.hedgeResult;
  const cp = getCp(pos.coin);
  const hedgeDirKr = pos.dir === "long" ? "숏" : "롱";
  const ac = "#a78bfa";

  // 수동 입력 시 실시간 OFF
  const handleManualEntry = (v) => {
    setHedgeLive(false);
    setHedgeEntry(v);
  };
  // 토글 ON/OFF
  const toggleLive = () => {
    if (hedgeLive) {
      setHedgeLive(false);
    } else {
      setHedgeLive(true);
      if (cp > 0) setHedgeEntry(String(cp));
    }
  };

  return (
    <div style={{
      marginTop: -6, marginBottom: 14, padding: 16, borderRadius: "0 0 14px 14px",
      background: "#0c081a", border: `1px solid ${ac}44`, borderTop: "none",
    }}>
      {/* 헤더 */}
      <div style={{ fontSize: 11, color: ac, fontWeight: 700, fontFamily: "'DM Sans'", marginBottom: 12, letterSpacing: 1 }}>
        🛡 {pos.coin} {pos.dir === "long" ? "롱" : "숏"} → <span style={{ color: pos.dir === "long" ? "#f87171" : "#34d399" }}>{hedgeDirKr}</span> 헷지
      </div>

      {/* 입력 */}
      <div style={S.grid2}>
        <Fld label={`${hedgeDirKr} 진입 예정가 ($)`}>
          <div style={{ position: "relative" }}>
            <PriceInp value={hedgeEntry} onChange={handleManualEntry} ph="헷지 진입가"
              cp={cp} mode={pos.dir === "long" ? "dca-short" : "dca-long"} accentColor={ac} />
            {/* 실시간 토글 */}
            <button onClick={toggleLive} style={{
              position: "absolute", top: 0, right: 0,
              padding: "5px 8px", fontSize: 9, fontWeight: 700,
              borderRadius: "0 8px 0 6px",
              border: `1px solid ${hedgeLive ? "#34d39944" : "#1e1e2e"}`,
              background: hedgeLive ? "#34d39915" : "transparent",
              color: hedgeLive ? "#34d399" : "#6b7280",
              cursor: "pointer", fontFamily: "'DM Sans'", transition: "all 0.15s",
              zIndex: 1,
            }}>
              {hedgeLive ? "● LIVE" : "○ 수동"}
            </button>
          </div>
        </Fld>
        <Fld label="투입금액 (USDT)">
          <Inp value={hedgeMargin} onChange={setHedgeMargin} ph="투입금액" />
          {calc && <MarginPresets freeMargin={calc.freeMargin} onSelect={setHedgeMargin} accentColor={ac} />}
        </Fld>
      </div>
      <div style={{ marginTop: 8 }}>
        <Fld label={`레버리지 (비워두면 기존 ${pos.leverage}x 동일)`}>
          <select value={hedgeLev || pos.leverage} onChange={(e) => setHedgeLev(e.target.value)} style={S.sel}>
            {LEV_PRESETS.map((l) => <option key={l} value={l}>x{l}</option>)}
          </select>
        </Fld>
      </div>

      {/* ── 결과 ── */}
      {hr && cp > 0 && (() => {
        const hasLiq = hr.liqBefore != null && hr.liqAfter != null;
        const liqAbsBefore = hr.liqDistBefore != null ? Math.abs(hr.liqDistBefore) : null;
        const liqAbsAfter = hr.liqDistAfter != null ? Math.abs(hr.liqDistAfter) : null;
        const liqC = (d) => d > 50 ? "#34d399" : d > 20 ? "#f59e0b" : "#f87171";

        return (
          <>
            <div style={{ height: 1, background: `${ac}22`, margin: "16px 0" }} />

            {/* 마진 부족 경고 */}
            {hr.marginInsufficient && (
              <div style={S.warnBox}>⚠ 사용 가능({fmt(calc.freeMargin)}) &lt; 투입금액({hedgeMargin}) USDT — 마진 부족</div>
            )}

            {/* 강청가 변화 */}
            {hasLiq ? (
              <div style={{
                padding: 14, borderRadius: 10, marginBottom: 10,
                background: "#08080f", border: `1px solid ${hr.liqImproved ? "#34d39933" : "#f8717133"}`,
              }}>
                <div style={{ fontSize: 10, color: ac, letterSpacing: 2, fontWeight: 700, fontFamily: "'DM Sans'", marginBottom: 10 }}>
                  강제 청산가 변화
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 6, alignItems: "center", marginBottom: 10 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>기존</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#f59e0b", fontFamily: "'DM Sans'" }}>
                      ${fmt(hr.liqBefore, hr.liqBefore > 100 ? 2 : 4)}
                    </div>
                    {liqAbsBefore != null && <div style={{ fontSize: 10, color: liqC(liqAbsBefore) }}>여유 {fmt(liqAbsBefore)}%</div>}
                  </div>
                  <div style={{ fontSize: 18, color: hr.liqImproved ? "#34d399" : "#f87171" }}>→</div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>헷지 후</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: hr.liqImproved ? "#34d399" : "#f87171", fontFamily: "'DM Sans'" }}>
                      ${fmt(hr.liqAfter, hr.liqAfter > 100 ? 2 : 4)}
                    </div>
                    {liqAbsAfter != null && <div style={{ fontSize: 10, color: liqC(liqAbsAfter) }}>여유 {fmt(liqAbsAfter)}%</div>}
                  </div>
                </div>
                {/* 바 */}
                <div style={{ marginBottom: 6 }}>
                  {[["기존", liqAbsBefore], ["헷지", liqAbsAfter]].map(([lb, dist]) => (
                    <div key={lb} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
                      <span style={{ fontSize: 8, color: "#4b5563", width: 24 }}>{lb}</span>
                      <div style={{ flex: 1, height: 4, background: "#1e1e2e", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{ height: "100%", borderRadius: 2, width: `${Math.min(dist || 0, 100)}%`, background: liqC(dist || 0), transition: "width 0.3s" }} />
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, textAlign: "center", color: hr.liqImproved ? "#34d399" : "#f87171" }}>
                  {hr.liqImproved
                    ? `✓ 청산가 ${fmt(Math.abs(hr.liqChange))}% ${pos.dir === "long" ? "하락" : "상승"} — 안전 거리 확대`
                    : `⚠ 청산가 ${fmt(Math.abs(hr.liqChange))}% ${pos.dir === "long" ? "상승" : "하락"} — 주의`}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "#4b5563", padding: "8px 0", textAlign: "center" }}>
                거래소 강제 청산가를 입력하면 청산가 변화를 확인할 수 있습니다
              </div>
            )}

            {/* 마진 변화 + 동시청산 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <div style={{ padding: 12, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e" }}>
                <div style={{ fontSize: 9, color: ac, fontWeight: 700, letterSpacing: 2, fontFamily: "'DM Sans'", marginBottom: 6 }}>마진 변화</div>
                <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>사용 마진</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0", marginBottom: 6 }}>
                  {fmt(calc.totalMargin)} → <span style={{ color: ac }}>{fmt(hr.afterTotalMargin)}</span>
                </div>
                <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>가용 마진</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: hr.afterFreeMargin >= 0 ? "#34d399" : "#f87171" }}>
                  {fmt(calc.freeMargin)} → {fmt(hr.afterFreeMargin)}
                </div>
                <div style={{ fontSize: 8, color: "#4b5563", marginTop: 4 }}>
                  차이: {fmtS(hr.afterFreeMargin - calc.freeMargin)} USDT
                </div>
              </div>
              <div style={{ padding: 12, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e" }}>
                <div style={{ fontSize: 9, color: ac, fontWeight: 700, letterSpacing: 2, fontFamily: "'DM Sans'", marginBottom: 6 }}>동시 청산 시</div>
                <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>기존 PnL</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: hr.currentOrigPnL >= 0 ? "#34d399" : "#f87171", marginBottom: 4 }}>
                  {fmtS(hr.currentOrigPnL)}
                </div>
                <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>헷지 PnL</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: hr.currentHedgePnL >= 0 ? "#34d399" : "#f87171", marginBottom: 4 }}>
                  {fmtS(hr.currentHedgePnL)}
                </div>
                <div style={{ borderTop: "1px solid #1e1e2e", paddingTop: 4 }}>
                  <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>순손익</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: hr.currentNet >= 0 ? "#34d399" : "#f87171" }}>
                    {fmtS(hr.currentNet)} USDT
                  </div>
                </div>
              </div>
            </div>

            {/* 본전가 */}
            {hr.breakevenAll && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                <div style={{ padding: 12, borderRadius: 10, background: `${ac}08`, border: `1px solid ${ac}33`, textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 3 }}>본전가 (전체 수수료)</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: ac, fontFamily: "'DM Sans'" }}>
                    ${fmt(hr.breakevenAll, hr.breakevenAll > 100 ? 2 : 4)}
                  </div>
                  {hr.beAllDist != null && (
                    <div style={{ fontSize: 10, color: hr.beAllDist >= 0 ? "#34d399" : "#f87171", marginTop: 2 }}>
                      현재가 대비 {fmtS(hr.beAllDist)}%
                    </div>
                  )}
                </div>
                <div style={{ padding: 12, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 3 }}>본전가 (청산 수수료만)</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#94a3b8", fontFamily: "'DM Sans'" }}>
                    {hr.breakevenClose ? `$${fmt(hr.breakevenClose, hr.breakevenClose > 100 ? 2 : 4)}` : "—"}
                  </div>
                  {hr.breakevenClose && cp > 0 && (
                    <div style={{ fontSize: 10, color: ((hr.breakevenClose - cp) / cp * 100) >= 0 ? "#34d399" : "#f87171", marginTop: 2 }}>
                      현재가 대비 {fmtS((hr.breakevenClose - cp) / cp * 100)}%
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 헷지 포지션 상세 */}
            <div style={S.detBox}>
              <div style={{ ...S.detTitle, color: ac }}>헷지 포지션 상세</div>
              <SL label="방향" value={`${hedgeDirKr} (${hr.hedgeDir.toUpperCase()})`} />
              <SL label="진입가" value={`$${fmt(hr.hEntry, hr.hEntry > 100 ? 2 : 4)}`} />
              <SL label="표시 마진" value={`${fmt(hr.hedgeMarginDisplay)} USDT`} />
              <SL label="진입 수수료" value={`-${fmt(hr.conv.openCost)} USDT`} warn />
              <SL label="청산 수수료 (예약)" value={`-${fmt(hr.conv.closeCost)} USDT`} warn />
              <SL label="수량" value={`${fmt(hr.conv.qty, 4)} ${pos.coin}`} />
              <SL label="포지션 크기" value={`${fmt(hr.conv.size, 0)} USDT`} />
              <SL label="레버리지" value={`${hr.hLev}x`} />
            </div>

            {/* 시나리오 테이블 */}
            {hr.scenarios.length > 0 && (
              <div style={S.tblWrap}>
                <div style={{ fontSize: 9, color: ac, fontWeight: 700, letterSpacing: 2, fontFamily: "'DM Sans'", marginBottom: 6 }}>가격별 시나리오</div>
                <table style={S.tbl}>
                  <thead>
                    <tr><TH>가격</TH><TH>기존PnL</TH><TH>헷지PnL</TH><TH>수수료</TH><TH>순손익</TH></tr>
                  </thead>
                  <tbody>
                    {hr.scenarios.map((s, i) => (
                      <tr key={i} style={{ background: s.isCurrent ? `${ac}08` : s.isSpecial ? `${ac}06` : "transparent" }}>
                        <TD c={s.isCurrent ? ac : s.isSpecial ? `${ac}99` : "#94a3b8"} bold={s.isCurrent || s.isSpecial}>
                          {s.isSpecial ? s.label : `$${fmt(s.price, s.price > 100 ? 0 : 2)}`}
                          {!s.isSpecial && <div style={{ fontSize: 8, color: "#4b5563" }}>{s.label}</div>}
                        </TD>
                        <TD c={s.origPnL >= 0 ? "#34d399" : "#f87171"}>{fmtS(s.origPnL)}</TD>
                        <TD c={s.hedgePnL >= 0 ? "#34d399" : "#f87171"}>{fmtS(s.hedgePnL)}</TD>
                        <TD c="#f59e0b">-{fmt(s.closeFee + hr.entryFees)}</TD>
                        <TD c={s.net >= 0 ? "#34d399" : "#f87171"} bold>{fmtS(s.net)}</TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}


function PosCard({ pos, idx, isSel, isHedge, isPyraLocked, isPyraCounter, onSelect, onPyra, onHedge, cp, fee }) {
  const dirC = pos.dir === "long" ? "#34d399" : "#f87171";
  const ep = n(pos.entryPrice), mg = n(pos.margin), lev = n(pos.leverage);
  const notional = mg * lev;
  const qty = ep > 0 ? notional / ep : 0;
  const liveNotional = cp > 0 && qty > 0 ? qty * cp : notional;
  const sign = pos.dir === "long" ? 1 : -1;
  const pnl = cp > 0 && qty > 0 ? sign * (cp - ep) * qty : null;
  const roe = pnl != null && mg > 0 ? (pnl / mg) * 100 : null;

  const borderColor = isHedge ? "#a78bfa" : isPyraCounter ? "#f59e0b" : isPyraLocked ? "#6b728044" : isSel ? "#0ea5e9" : "#1e1e2e";
  const bgColor = isHedge ? "#0e0a18" : isPyraCounter ? "#120e04" : isPyraLocked ? "#0a0a0e" : isSel ? "#060a14" : "#08080f";

  return (
    <div style={{ ...S.card, borderColor, background: bgColor }}>
      {/* 상단: 코인 + 방향 + 레버 + 버튼 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "#e2e8f0", fontFamily: "'IBM Plex Mono'" }}>{pos.coin}</span>
          <span style={{
            fontSize: 11, fontWeight: 700, color: dirC, padding: "2px 8px", borderRadius: 4,
            background: pos.dir === "long" ? "#34d39912" : "#f8717112",
            border: `1px solid ${dirC}33`,
          }}>{pos.dir === "long" ? "LONG" : "SHORT"}</span>
          <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "'IBM Plex Mono'" }}>x{lev}</span>
          {isPyraLocked && <span style={{ fontSize: 10, color: "#6b7280", fontWeight: 600 }}>🔒 물린</span>}
          {isPyraCounter && <span style={{ fontSize: 10, color: "#f59e0b", fontWeight: 600 }}>🔥 불타기</span>}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={onSelect} style={{
            ...S.miniBtn,
            background: isSel ? "#0ea5e915" : "transparent",
            borderColor: isSel ? "#0ea5e944" : "#1e1e2e",
            color: isSel ? "#0ea5e9" : "#6b7280",
          }}>{isSel ? "✓ 선택됨" : "물타기"}</button>
          <button onClick={onPyra} style={{
            ...S.miniBtn,
            background: isPyraCounter ? "#f59e0b15" : "transparent",
            borderColor: isPyraCounter ? "#f59e0b44" : "#1e1e2e",
            color: isPyraCounter ? "#f59e0b" : "#6b7280",
          }}>{isPyraCounter ? "✓ 불타기" : "🔥"}</button>
          <button onClick={onHedge} style={{
            ...S.miniBtn,
            background: isHedge ? "#a78bfa15" : "transparent",
            borderColor: isHedge ? "#a78bfa44" : "#1e1e2e",
            color: isHedge ? "#a78bfa" : "#6b7280",
          }}>{isHedge ? "✓ 헷지" : "헷지"}</button>
        </div>
      </div>

      {/* 데이터 행 */}
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#94a3b8", fontFamily: "'IBM Plex Mono'" }}>
        <div>
          <span style={{ fontSize: 9, color: "#4b5563", fontFamily: "'DM Sans'" }}>진입가</span>
          <div style={{ fontWeight: 600 }}>{fmt(ep, ep > 100 ? 2 : 4)}</div>
        </div>
        <div>
          <span style={{ fontSize: 9, color: "#4b5563", fontFamily: "'DM Sans'" }}>마진</span>
          <div style={{ fontWeight: 600 }}>{fmt(mg, 0)}</div>
        </div>
        <div>
          <span style={{ fontSize: 9, color: "#4b5563", fontFamily: "'DM Sans'" }}>포지션</span>
          <div style={{ fontWeight: 600 }}>{fmt(liveNotional, 0)}</div>
        </div>
        {pos.liquidationPrice && n(pos.liquidationPrice) > 0 && (
          <div>
            <span style={{ fontSize: 9, color: "#4b5563", fontFamily: "'DM Sans'" }}>청산가</span>
            <div style={{ fontWeight: 600, color: "#f87171" }}>{fmt(n(pos.liquidationPrice), n(pos.liquidationPrice) > 100 ? 2 : 4)}</div>
          </div>
        )}
      </div>

      {/* PnL */}
      {pnl != null && (
        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: pnl >= 0 ? "#34d399" : "#f87171", fontFamily: "'IBM Plex Mono'" }}>
          PnL {fmtS(pnl)} ({fmtS(roe)}%)
        </div>
      )}
    </div>
  );
}

function SumCard({ label, value, color, sub }) {
  return (
    <div style={S.sumCard}>
      <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color, fontFamily: "'IBM Plex Mono'" }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "#4b5563", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}
function HLCard({ label, value, delta, deltaColor, sub, wide }) {
  return (
    <div style={{ ...S.hlCard, gridColumn: wide ? "1 / -1" : "auto" }}>
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: wide ? 22 : 20, fontWeight: 700, color: "#f1f5f9", fontFamily: "'DM Sans'" }}>{value}</div>
      {delta && <div style={{ fontSize: 12, color: deltaColor, marginTop: 4, fontWeight: 500 }}>{delta}</div>}
      {sub && <div style={{ fontSize: 10, color: "#6b7280", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}
function TH({ children }) { return <th style={S.th}>{children}</th>; }
function TD({ children, c, bold }) { return <td style={{ ...S.td, color: c || "#94a3b8", fontWeight: bold ? 600 : 400 }}>{children}</td>; }
function SL({ label, value, warn }) {
  return (
    <div style={S.sl}>
      <span style={{ color: "#6b7280" }}>{label}</span>
      <span style={{ color: warn ? "#f87171" : "#cbd5e1", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

/* ═══════════════════════════════════════════
   STYLES
   ═══════════════════════════════════════════ */
const S = {
  root: {
    minHeight: "100vh", background: "#050508", color: "#cbd5e1",
    fontFamily: "'IBM Plex Mono', monospace", padding: "20px 12px",
  },
  wrap: { maxWidth: 760, margin: "0 auto" },
  hdr: { marginBottom: 28, paddingBottom: 20, borderBottom: "1px solid #111118" },
  hdrRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  hdrDot: { width: 6, height: 6, borderRadius: "50%", background: "#34d399", boxShadow: "0 0 8px #34d39944" },
  hdrBadge: { fontSize: 10, fontWeight: 700, letterSpacing: 2.5, color: "#34d399", fontFamily: "'DM Sans'" },
  hdrTitle: { fontSize: 28, fontWeight: 800, color: "#f8fafc", fontFamily: "'DM Sans'", letterSpacing: -0.5 },
  hdrSub: { fontSize: 12, color: "#4b5563", marginTop: 4, fontFamily: "'DM Sans'" },

  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  grid3: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 },

  inp: {
    width: "100%", padding: "10px 12px", background: "#0a0a12", border: "1px solid #1e1e2e",
    borderRadius: 8, color: "#e2e8f0", fontSize: 14, fontFamily: "'IBM Plex Mono'",
    outline: "none", transition: "border-color 0.15s",
  },
  sel: {
    width: "100%", padding: "10px 12px", background: "#0a0a12", border: "1px solid #1e1e2e",
    borderRadius: 8, color: "#e2e8f0", fontSize: 13, fontFamily: "'IBM Plex Mono'",
    outline: "none", appearance: "none", WebkitAppearance: "none",
  },

  card: {
    padding: 16, borderRadius: 12, border: "1px solid #1e1e2e", background: "#08080f",
    marginBottom: 10, transition: "border-color 0.2s",
  },
  miniBtn: {
    padding: "4px 10px", fontSize: 11, fontWeight: 500, border: "1px solid #1e1e2e",
    borderRadius: 6, background: "transparent", cursor: "pointer", fontFamily: "'DM Sans'",
  },
  autoRow: {
    marginTop: 10, padding: "8px 10px", background: "#0a0a14", borderRadius: 6,
    fontSize: 11, color: "#4b5563", display: "flex", gap: 16, flexWrap: "wrap",
  },
  addBtn: {
    width: "100%", padding: "10px 0", border: "1px dashed #1e1e2e", borderRadius: 8,
    background: "transparent", color: "#4b5563", cursor: "pointer", fontSize: 12,
    fontFamily: "'DM Sans'", marginTop: 6,
  },

  summaryGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  sumCard: { padding: 12, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e" },

  availBox: {
    marginTop: 8, padding: 14, borderRadius: 10,
    background: "#08080f", border: "1px solid #1e1e2e",
  },
  availRow: { display: "flex", gap: 8, alignItems: "stretch" },

  shortfallBox: {
    marginTop: 8, padding: 10, borderRadius: 6,
    background: "#0ea5e908", border: "1px solid #0ea5e922",
    fontSize: 12, color: "#cbd5e1", lineHeight: 1.6,
  },

  liqBar: {
    marginTop: 10, padding: 16, borderRadius: 10,
    background: "#08080f", border: "1px solid #1e1e2e",
  },
  liqBarInner: { display: "flex", justifyContent: "space-between", alignItems: "flex-end" },
  liqVisual: { marginTop: 12 },
  liqTrack: { height: 6, background: "#1e1e2e", borderRadius: 3, overflow: "hidden" },
  liqFill: { height: "100%", borderRadius: 3, transition: "width 0.3s" },
  liqEmpty: {
    marginTop: 10, padding: 14, borderRadius: 8, background: "#08080f",
    border: "1px dashed #1e1e2e", textAlign: "center", fontSize: 12, color: "#4b5563",
  },

  modeRow: { display: "flex", gap: 6, marginBottom: 12 },
  modeBtn: {
    flex: 1, padding: "10px 0", fontSize: 12, fontWeight: 600, borderRadius: 8,
    border: "1px solid #1e1e2e", cursor: "pointer", fontFamily: "'DM Sans'",
    background: "transparent", transition: "all 0.15s",
  },
  splitToggle: {
    width: "100%", padding: "8px 0", marginTop: 6, border: "1px dashed #1e1e2e",
    borderRadius: 8, background: "transparent", color: "#4b5563", cursor: "pointer",
    fontSize: 11, fontFamily: "'DM Sans'", transition: "all 0.15s",
  },
  splitPanel: {
    marginTop: 8, padding: 14, borderRadius: 10,
    background: "#06060e", border: "1px solid #1e1e2e",
  },
  splitGrid: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8,
  },
  splitCard: {
    padding: 12, borderRadius: 8, border: "1px solid #1e1e2e", background: "#0a0a14",
  },
  applyBtn: {
    padding: "4px 10px", fontSize: 10, fontWeight: 600, borderRadius: 4,
    border: "1px solid #0ea5e933", background: "#0ea5e910", color: "#0ea5e9",
    cursor: "pointer", fontFamily: "'DM Sans'", whiteSpace: "nowrap",
  },
  dcaRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 },
  dcaNum: {
    width: 24, height: 24, borderRadius: "50%", background: "#0ea5e915", border: "1px solid #0ea5e933",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 11, color: "#0ea5e9", fontWeight: 600, flexShrink: 0,
  },
  rmSm: {
    width: 32, height: 40, border: "1px solid #1e1e2e", background: "transparent",
    color: "#f87171", borderRadius: 6, cursor: "pointer", fontSize: 16,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  empty: { textAlign: "center", padding: "36px 16px", color: "#333", fontSize: 13, fontFamily: "'DM Sans'" },
  divider: { height: 1, margin: "28px 0", background: "linear-gradient(90deg, transparent, #0ea5e922, transparent)" },

  hlGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 },
  hlCard: { padding: 16, borderRadius: 10, background: "#0a0a14", border: "1px solid #1e1e2e" },

  revHL: {
    padding: 20, borderRadius: 12, background: "#0a0a14", border: "1px solid #0ea5e944",
    marginBottom: 12, textAlign: "center", fontFamily: "'DM Sans'",
  },

  tblWrap: { overflowX: "auto", borderRadius: 10, border: "1px solid #1e1e2e", marginBottom: 12 },
  tbl: { width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "'IBM Plex Mono'" },
  th: {
    padding: "10px 10px", textAlign: "left", color: "#4b5563", fontWeight: 500, fontSize: 10,
    letterSpacing: 0.5, borderBottom: "1px solid #1e1e2e", background: "#08080f",
    whiteSpace: "nowrap", fontFamily: "'DM Sans'",
  },
  td: { padding: "10px 10px", borderBottom: "1px solid #111118", whiteSpace: "nowrap" },

  detBox: { padding: 16, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e", marginBottom: 12 },
  detTitle: { fontSize: 10, color: "#4b5563", letterSpacing: 2, marginBottom: 10, fontFamily: "'DM Sans'" },
  sl: { display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #0e0e18", fontSize: 12 },

  warnBox: {
    padding: 14, borderRadius: 8, background: "#f8717108", border: "1px solid #f8717122",
    fontSize: 12, color: "#f87171", lineHeight: 1.6, marginBottom: 12,
  },

  exitBox: {
    padding: 16, borderRadius: 10, background: "#08080f", border: "1px solid #1e1e2e",
    marginBottom: 12,
  },
  exitTitle: {
    fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase",
    color: "#f59e0b", fontFamily: "'DM Sans'", marginBottom: 4,
  },
  exitCustomRow: {
    display: "flex", alignItems: "center", gap: 8, marginTop: 10,
  },

  cdBox: {
    padding: 16, borderRadius: 10,
    background: "#0a0a14", border: "1px solid #0ea5e922",
    marginBottom: 12,
  },
  cdTitle: {
    fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase",
    color: "#0ea5e9", fontFamily: "'DM Sans'", marginBottom: 4,
  },

  footer: { marginTop: 28, textAlign: "center", fontSize: 11, color: "#333", fontFamily: "'DM Sans'" },
};
