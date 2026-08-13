"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { REGISTRY, CATEGORIES, byId, defaults, seriesOutputs, outputsOfType, primitiveOutputs } from "./indicators";
import { PRIMITIVE_TYPES } from "./primitives";

/* ═══════════════════════════════════════════
   POSITION CHART
   Binance 캔들 + 회원 포지션 가로선
   ═══════════════════════════════════════════ */

const INTERVALS = [
  { id: "1m", label: "1분" },
  { id: "3m", label: "3분" },
  { id: "5m", label: "5분" },
  { id: "15m", label: "15분" },
  { id: "1h", label: "1시간" },
  { id: "4h", label: "4시간" },
  { id: "1d", label: "일봉" },
];

// lightweight-charts 는 시간축을 항상 UTC 로 그린다. 타임스탬프를 미리 밀어
// 표시값이 KST 가 되게 한다 (라이브러리에 타임존 옵션이 없다).
const KST_SHIFT = 9 * 3600;

// 봉이 짧을수록 새 봉을 빨리 받아야 한다. 30초 고정이면 1분봉에서 새 봉이
// 최대 30초 늦게 뜨고, 그동안 실시간 틱이 이미 끝난 봉을 계속 늘린다.
const REFRESH_MS = { "1m": 5000, "3m": 10000, "5m": 15000 };
const DEFAULT_REFRESH_MS = 30000;
const refreshFor = (itv) => REFRESH_MS[itv] || DEFAULT_REFRESH_MS;

// 자동 축소에 포함할 선의 범위. 헷지 포지션은 강청가가 현재가의 17배 같은
// 값으로 나올 수 있는데, 그대로 넣으면 캔들이 한 줄로 눌린다.
const SCALE_MIN = 0.5;
const SCALE_MAX = 2;

const CHART_HEIGHT = 480;      // 가격 창 (지표를 켜도 줄지 않는다)
const SUB_PANE_H = 90;         // 보조 창 하나당 높이 — 전체 차트가 세로로 늘어난다
const MAX_SUB_PANES = 3;
const STORE_KEY = "cs-chart-indicators";   // 보는 사람 취향이라 회원과 무관하게 전역 저장
const DASH_KEY = "cs-chart-dash-open";

let iidSeq = 0;
const nextIid = () => `i${Date.now().toString(36)}${++iidSeq}`;

const THEME = {
  dark: {
    bg: "#08080f", text: "#8b8ba7", grid: "#ffffff0a", border: "#ffffff14",
    up: "#34d399", down: "#f87171",
  },
  light: {
    bg: "#ffffff", text: "#64748b", grid: "#0000000a", border: "#00000014",
    up: "#10b981", down: "#ef4444",
  },
};

const LONG = "#34d399";
const SHORT = "#f87171";
const LIQ = "#f87171";
const BE = "#94a3b8";
const SIM = "#0ea5e9";
const INSTANCE_PALETTE = ["#f59e0b", "#0ea5e9", "#a78bfa", "#34d399", "#f87171", "#22d3ee", "#ec4899"];

// 코인 가격대별 호가 단위. 안 주면 선이 엉뚱한 자리에 스냅된다.
function priceFmt(p) {
  if (p >= 10000) return { precision: 1, minMove: 0.1 };
  if (p >= 100) return { precision: 2, minMove: 0.01 };
  if (p >= 1) return { precision: 4, minMove: 0.0001 };
  return { precision: 5, minMove: 0.00001 };
}

const fmtNum = (v, d = 2) =>
  v != null && isFinite(v)
    ? Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
    : "—";

// 손익분기점 — calc.jsx 물타기 시뮬과 동일한 공식을 쓴다 (두 화면 값이 어긋나면 안 됨)
const breakeven = (ep, dir, fee) =>
  dir === "long" ? (ep * (1 + fee)) / (1 - fee) : (ep * (1 - fee)) / (1 + fee);

/* 캔들 배열의 "작업용 사본".
   실시간 틱이 마지막 봉을 제자리 변형하는데, 그 배열이 캐시에도 들어 있으면
   봉간격을 바꿨다 돌아왔을 때 오염된 봉이 남는다. 마지막 하나만 복제해 끊는다. */
const workingCopy = (arr) =>
  arr.length ? [...arr.slice(0, -1), { ...arr[arr.length - 1] }] : [];

export default function PositionChart({ coins, positions, liqPerCoin, fee, theme, livePrices, simOverlay }) {
  const [coin, setCoin] = useState(coins[0] || "");
  const [itv, setItv] = useState("15m");
  const [showLiq, setShowLiq] = useState(true);
  const [showBe, setShowBe] = useState(false);
  const [status, setStatus] = useState("loading"); // loading | ok | nodata | error
  const [offscreen, setOffscreen] = useState([]);  // 범위 밖이라 못 그린 선들
  const [isFull, setIsFull] = useState(false);

  // ── 보조지표 ──
  // 토글이 아니라 "인스턴스" 배열이다. 같은 지표를 파라미터만 달리해 여러 개 얹을 수 있다.
  const [instances, setInstances] = useState(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x) => x && byId(x.id)) : [];
    } catch { return []; }
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [settingIid, setSettingIid] = useState(null);
  const [chartReady, setChartReady] = useState(0);
  const [dataVersion, setDataVersion] = useState(0);
  const [totalH, setTotalH] = useState(CHART_HEIGHT);
  const [dashes, setDashes] = useState([]);        // 지표가 내놓은 상태 표
  const [dashOpen, setDashOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(DASH_KEY) !== "0";
  });

  const boxRef = useRef(null);            // 카드 전체 (전체화면 시 뷰포트를 덮는 요소)
  const areaRef = useRef(null);           // 차트가 차지할 영역
  const wrapRef = useRef(null);           // lightweight-charts 가 붙는 요소
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const libRef = useRef(null);
  const linesRef = useRef(new Map());     // key -> { line, price, color, style, title }
  const scalePricesRef = useRef([]);      // autoscale 에 포함할 가격들
  const candlesRef = useRef(null);
  const cacheRef = useRef(new Map());     // `${coin}:${itv}` -> candles (원본 · 변형 금지)
  const tokenRef = useRef(0);             // 코인/봉간격 전환 레이스 가드
  const keyRef = useRef("");              // 현재 코인·봉간격
  const fitKeyRef = useRef("");           // 전체 보기를 이미 맞춘 조합
  const wheelCleanupRef = useRef(null);
  const indRef = useRef(new Map());       // iid -> { seriesByKey, markersByKey, guided }
  const paneRef = useRef(new Map());      // indicatorId -> IPaneApi (같은 지표는 창 공유)
  const barColorRef = useRef(new Map());  // iid -> Map(time -> color)
  const totalHRef = useRef(CHART_HEIGHT);
  const fullRef = useRef(false);
  const sizeRef = useRef({ w: 0, h: 0 }); // 리사이즈 루프 차단용
  const paintedRef = useRef("");          // 마지막으로 그린 봉 구간의 지문

  const cp = coin ? Number(livePrices?.[coin] || 0) : 0;

  // 보유 코인이 바뀌면 현재 탭이 유효한지 확인
  const coinKey = coins.join(",");
  useEffect(() => {
    if (coins.length === 0) return;
    if (!coins.includes(coin)) setCoin(coins[0]);
  }, [coinKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 크기 반영 ──────────────────────────────────
     ResizeObserver 가 자기가 리사이즈하는 요소를 관찰하면 되먹임이 생긴다.
     바깥 카드를 관찰하고, 마지막에 적용한 크기와 같으면 건너뛴다. */

  // 보조 창 높이. 전체화면에선 비례로 키우되 가격 창이 절반 아래로 내려가지 않게 막는다.
  const applyPaneHeights = useCallback((total) => {
    const chart = chartRef.current;
    if (!chart) return;
    let panes;
    try { panes = chart.panes(); } catch { return; }
    const sub = panes.length - 1;
    if (sub <= 0) return;
    const cap = Math.floor((total * 0.5) / sub);
    const h = Math.max(60, Math.min(cap, fullRef.current ? Math.floor(total * 0.16) : SUB_PANE_H));
    for (let i = 1; i < panes.length; i++) {
      try { panes[i].setHeight(h); } catch { /* 창이 방금 지워졌을 수 있다 */ }
    }
  }, []);

  const applySize = useCallback(() => {
    const chart = chartRef.current, wrap = wrapRef.current, area = areaRef.current;
    if (!chart || !wrap || !area) return;
    const w = wrap.clientWidth;
    const h = fullRef.current ? Math.max(240, area.clientHeight) : totalHRef.current;
    if (w <= 0 || h <= 0) return;
    if (w === sizeRef.current.w && h === sizeRef.current.h) return;
    sizeRef.current = { w, h };
    chart.resize(w, h);
    applyPaneHeights(h);
  }, [applyPaneHeights]);

  /* ── 차트 생성 (1회) ────────────────────────────── */
  useEffect(() => {
    let disposed = false;
    let ro = null;

    (async () => {
      const lib = await import("lightweight-charts");
      // StrictMode 는 effect 를 두 번 돌린다. await 사이에 정리됐으면 만들지 않는다.
      if (disposed || !wrapRef.current) return;
      libRef.current = lib;

      const t = THEME[theme] || THEME.dark;
      const chart = lib.createChart(wrapRef.current, {
        width: wrapRef.current.clientWidth,
        height: CHART_HEIGHT,
        layout: { background: { color: t.bg }, textColor: t.text, attributionLogo: false },
        grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
        rightPriceScale: { borderColor: t.border },
        timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false },
        crosshair: { mode: lib.CrosshairMode.Normal },
      });

      const series = chart.addSeries(lib.CandlestickSeries, {
        upColor: t.up, downColor: t.down,
        borderUpColor: t.up, borderDownColor: t.down,
        wickUpColor: t.up, wickDownColor: t.down,
        priceLineVisible: true,   // 현재가선은 시리즈 내장 기능으로 공짜
        lastValueVisible: true,
        autoscaleInfoProvider: (original) => {
          const res = original();
          const extra = scalePricesRef.current;
          if (!res || !res.priceRange || extra.length === 0) return res;
          let { minValue, maxValue } = res.priceRange;
          extra.forEach((p) => {
            if (p < minValue) minValue = p;
            if (p > maxValue) maxValue = p;
          });
          return { ...res, priceRange: { minValue, maxValue } };
        },
      });

      chartRef.current = chart;
      seriesRef.current = series;

      if (candlesRef.current) {
        series.setData(candlesRef.current);
        chart.timeScale().fitContent();
        fitKeyRef.current = keyRef.current;
      }

      // ── 가격축 휠 확대 ──
      // 라이브러리는 wheel 리스너를 차트 루트에 1개만 달고 시간축 확대에만 쓴다.
      // 가격축 영역일 때만 캡처 단계에서 가로채 우리가 처리하고 전파를 끊는다.
      const root = wrapRef.current.querySelector(".tv-lightweight-charts");
      if (root) {
        const onWheel = (e) => {
          const ch = chartRef.current, se = seriesRef.current;
          if (!ch || !se) return;
          const rb = root.getBoundingClientRect();
          const ps = ch.priceScale("right");
          if (e.clientX < rb.right - ps.width()) return;   // 가격축 밖 → 기본 동작(시간축) 유지
          const tsH = typeof ch.timeScale().height === "function" ? ch.timeScale().height() : 0;
          const y = e.clientY - rb.top;
          if (y < 0 || y > rb.height - tsH) return;        // 우하단 코너
          // 보조 창(지표)의 가격축은 건드리지 않는다. 안 막으면 엉뚱하게 가격 창이 확대된다.
          const p0 = ch.panes()[0];
          const p0h = p0 && typeof p0.getHeight === "function" ? p0.getHeight() : rb.height - tsH;
          if (y > p0h) return;
          const r = ps.getVisibleRange();
          const pivot = se.coordinateToPrice(y);
          if (!r || pivot == null) return;
          e.preventDefault();
          e.stopPropagation();
          const f = e.deltaY < 0 ? 0.9 : 1 / 0.9;          // 위로 굴리면 확대
          let from = pivot + (r.from - pivot) * f;
          const to = pivot + (r.to - pivot) * f;
          if (!isFinite(from) || !isFinite(to) || !(to > from)) return;
          if (from <= 0) from = to * 1e-6;                 // 가격은 0 이하로 못 간다
          ps.setAutoScale(false);
          ps.setVisibleRange({ from, to });
        };
        root.addEventListener("wheel", onWheel, { capture: true, passive: false });
        wheelCleanupRef.current = () => root.removeEventListener("wheel", onWheel, { capture: true });
      }

      ro = new ResizeObserver(() => applySize());
      if (boxRef.current) ro.observe(boxRef.current);

      setChartReady((v) => v + 1);   // 지표 반영 effect 를 깨운다
    })();

    return () => {
      disposed = true;
      if (ro) ro.disconnect();
      if (wheelCleanupRef.current) { wheelCleanupRef.current(); wheelCleanupRef.current = null; }
      linesRef.current.clear();
      indRef.current.clear();
      paneRef.current.clear();
      barColorRef.current.clear();
      if (chartRef.current) chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 테마 전환 (차트 재생성 없이 색만 교체) ───────── */
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    const t = THEME[theme] || THEME.dark;
    chart.applyOptions({
      layout: { background: { color: t.bg }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
    series.applyOptions({
      upColor: t.up, downColor: t.down,
      borderUpColor: t.up, borderDownColor: t.down,
      wickUpColor: t.up, wickDownColor: t.down,
    });
  }, [theme]);

  /* ── 캔들 그리기 (지표의 캔들 색칠을 얹어서) ───────── */
  const colorAt = (time) => {
    let col;
    barColorRef.current.forEach((m) => { const c = m.get(time); if (c) col = c; });
    return col;   // 여러 지표가 칠하면 마지막 것이 이긴다
  };

  const paintCandles = useCallback((force = false) => {
    const s = seriesRef.current, c = candlesRef.current, chart = chartRef.current;
    if (!s || !c || !c.length) return;

    /* 봉 구간(길이·양끝 시각)이 바뀌면 십자선 위치를 먼저 비운다.
       라이브러리는 십자선이 가리키던 봉을 캐시해 두는데(precomputedBars),
       봉이 밀려 그 인덱스가 사라지면 다음 update() 때 ensureNotNull 이
       "Value is null" 로 터진다.
       값만 갱신되는 폴링에서는 인덱스가 그대로라 비울 필요가 없다.
       매번 비우면 가만히 있는 십자선이 주기적으로 사라져 거슬린다. */
    const win = `${c.length}:${c[0].time}:${c[c.length - 1].time}`;
    if (force || win !== paintedRef.current) {
      paintedRef.current = win;
      try { chart?.clearCrosshairPosition?.(); } catch { /* 무시 */ }
    }

    s.setData(barColorRef.current.size === 0 ? c : c.map((x) => {
      const col = colorAt(x.time);
      return col ? { ...x, color: col, borderColor: col, wickColor: col } : x;
    }));
  }, []);

  /* ── 캔들 로딩 ──────────────────────────────────── */
  useEffect(() => {
    if (!coin) return;
    const token = ++tokenRef.current;
    const ctrl = new AbortController();
    const key = `${coin}:${itv}`;
    keyRef.current = key;

    const paint = (candles) => {
      if (token !== tokenRef.current) return;  // 늦게 온 응답이 최신을 덮어쓰지 않도록
      candlesRef.current = workingCopy(candles);
      setDataVersion((v) => v + 1);   // 지표 재계산 트리거
      setStatus("ok");
      if (!seriesRef.current) return;          // 차트가 아직 준비 전이면 생성 시점에 그린다
      paintCandles();
      // 전체 보기는 코인·봉간격이 바뀐 직후 1회만.
      // 갱신마다 부르면 사용자가 확대해둔 것이 계속 풀린다.
      if (fitKeyRef.current !== key) {
        chartRef.current?.timeScale().fitContent();
        chartRef.current?.priceScale("right").setAutoScale(true);
        fitKeyRef.current = key;
      }
    };

    const cached = cacheRef.current.get(key);
    if (cached) paint(cached);
    else setStatus("loading");

    const load = async () => {
      try {
        const r = await fetch(
          `https://fapi.binance.com/fapi/v1/klines?symbol=${coin}USDT&interval=${itv}&limit=500`,
          { signal: ctrl.signal }
        );
        if (!r.ok) {
          if (token === tokenRef.current) setStatus(r.status === 400 ? "nodata" : "error");
          return;
        }
        const raw = await r.json();
        if (!Array.isArray(raw) || raw.length === 0) {
          if (token === tokenRef.current) setStatus("nodata");
          return;
        }
        const candles = raw.map((k) => ({
          time: Math.floor(k[0] / 1000) + KST_SHIFT,
          open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
        }));
        cacheRef.current.set(key, candles);
        paint(candles);
      } catch (e) {
        if (e.name !== "AbortError" && token === tokenRef.current) setStatus("error");
      }
    };

    load();
    const timer = setInterval(load, refreshFor(itv));
    return () => { ctrl.abort(); clearInterval(timer); };
  }, [coin, itv, paintCandles]);

  /* ── 마지막 봉 실시간 갱신 (3초 시세) ───────────── */
  useEffect(() => {
    const s = seriesRef.current;
    const c = candlesRef.current;
    if (!s || !c || c.length === 0 || !(cp > 0)) return;
    const last = c[c.length - 1];   // workingCopy 로 복제된 객체 — 캐시를 오염시키지 않는다
    last.close = cp;
    if (cp > last.high) last.high = cp;
    if (cp < last.low) last.low = cp;
    const col = colorAt(last.time);
    // setData 재호출은 정렬 검증에 걸린다. 마지막 봉만 update.
    try {
      s.update(col ? { ...last, color: col, borderColor: col, wickColor: col } : last);
    } catch {
      // 라이브러리 내부 십자선 캐시가 어긋난 경우. 비우고 통째로 다시 그리면 복구된다.
      try { chartRef.current?.clearCrosshairPosition?.(); } catch { /* 무시 */ }
      paintCandles(true);
    }
  }, [cp, paintCandles]);

  /* ── 호가 단위 ──────────────────────────────────── */
  useEffect(() => {
    const s = seriesRef.current;
    if (!s || !(cp > 0)) return;
    s.applyOptions({ priceFormat: { type: "price", ...priceFmt(cp) } });
  }, [coin, cp > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 그릴 선 목록 ───────────────────────────────── */
  const spec = useMemo(() => {
    if (!coin) return [];
    const out = [];
    (positions || []).filter((p) => p.coin === coin && p.ep > 0).forEach((p) => {
      out.push({
        key: `avg-${p.id}`, price: p.ep,
        color: p.dir === "long" ? LONG : SHORT, style: "solid",
        title: `${p.dir === "long" ? "롱" : "숏"} 평단`,
      });
      if (showBe) {
        out.push({
          key: `be-${p.id}`, price: breakeven(p.ep, p.dir, fee),
          color: BE, style: "dashed",
          title: `${p.dir === "long" ? "롱" : "숏"} 본전`,
        });
      }
    });
    if (showLiq) {
      const d = liqPerCoin?.[coin];
      if (d && d.liq != null && d.liq > 0) {
        out.push({ key: `liq-${coin}`, price: d.liq, color: LIQ, style: "dashed", title: "강청가" });
      }
    }
    // 마지막으로 만진 시뮬 하나만. 코인이 다르면 그리지 않는다.
    if (simOverlay) {
      const a = simOverlay.avgByCoin?.[coin];
      if (a > 0) {
        out.push({ key: "sim-avg", price: a, color: SIM, style: "dashed", title: `${simOverlay.label} 평단` });
      }
      const l = simOverlay.liqMap?.[coin];
      if (l && l.liq != null && l.liq > 0 && showLiq) {
        out.push({ key: "sim-liq", price: l.liq, color: SIM, style: "dashed", title: `${simOverlay.label} 강청가` });
      }
    }
    return out;
  }, [coin, positions, liqPerCoin, fee, showLiq, showBe, simOverlay]);

  /* ── 선 반영 (차이나는 것만 갱신 — 3초마다 재생성하면 깜빡인다) ── */
  useEffect(() => {
    const s = seriesRef.current;
    const lib = libRef.current;
    if (!s || !lib) return;

    const styleOf = (v) => (v === "dashed" ? lib.LineStyle.Dashed : lib.LineStyle.Solid);
    const inScale = [];
    const out = [];
    const wanted = new Map();

    spec.forEach((l) => {
      if (!isFinite(l.price) || l.price <= 0) return;
      const far = cp > 0 && (l.price < cp * SCALE_MIN || l.price > cp * SCALE_MAX);
      if (far) {
        out.push({ ...l, above: l.price > cp, pct: ((l.price - cp) / cp) * 100 });
        return;   // 범위 밖 선은 그리지 않고 아래 스트립에 표기
      }
      wanted.set(l.key, l);
      inScale.push(l.price);
    });

    const cur = linesRef.current;
    // 사라진 선 제거
    [...cur.keys()].forEach((k) => {
      if (!wanted.has(k)) { s.removePriceLine(cur.get(k).line); cur.delete(k); }
    });
    // 추가 / 값 변경
    wanted.forEach((l, k) => {
      const prev = cur.get(k);
      if (!prev) {
        const line = s.createPriceLine({
          price: l.price, color: l.color, lineWidth: l.style === "solid" ? 2 : 1,
          lineStyle: styleOf(l.style), axisLabelVisible: true, title: l.title,
        });
        cur.set(k, { line, ...l });
      } else if (prev.price !== l.price || prev.color !== l.color || prev.title !== l.title) {
        prev.line.applyOptions({ price: l.price, color: l.color, title: l.title });
        cur.set(k, { ...prev, ...l });
      }
    });

    scalePricesRef.current = inScale;
    // 옵션을 다시 적용해야 autoscale 이 새 범위로 다시 계산된다
    s.applyOptions({});
    setOffscreen(out);
  }, [spec, cp]);

  /* ── 지표: 저장 ─────────────────────────────────── */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(instances)); } catch { /* 무시 */ }
  }, [instances]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(DASH_KEY, dashOpen ? "1" : "0"); } catch { /* 무시 */ }
  }, [dashOpen]);

  /* ── 지표: 시리즈·창·마커·캔들색·표 반영 ─────────── */
  useEffect(() => {
    const chart = chartRef.current, lib = libRef.current;
    if (!chart || !lib) return;
    const candles = candlesRef.current;
    const store = indRef.current;
    const panes = paneRef.current;
    const barsBefore = barColorRef.current.size;

    // 1) 사라진 인스턴스 정리 (시리즈를 창보다 먼저 지워야 빈 창을 지울 수 있다)
    [...store.keys()].forEach((iid) => {
      if (instances.some((x) => x.iid === iid)) return;
      const rec = store.get(iid);
      rec.seriesByKey.forEach((s) => { try { chart.removeSeries(s); } catch { /* 이미 제거됨 */ } });
      rec.markersByKey.forEach((m) => { try { m.detach(); } catch { /* 무시 */ } });
      rec.primByKey.forEach((pr) => { try { pr.detach(); } catch { /* 무시 */ } });
      store.delete(iid);
      barColorRef.current.delete(iid);
    });

    // 2) 창 확보 / 정리 — 같은 지표 id 는 한 창을 공유한다
    const wantPanes = [...new Set(instances.filter((i) => byId(i.id)?.target === "pane").map((i) => i.id))];
    [...panes.keys()].forEach((k) => {
      if (wantPanes.includes(k)) return;
      try { chart.removePane(panes.get(k).paneIndex()); } catch { /* 무시 */ }
      panes.delete(k);
    });
    wantPanes.forEach((k) => { if (!panes.has(k)) panes.set(k, chart.addPane()); });

    // 3) 인스턴스별 반영
    const nextDashes = [];
    instances.forEach((inst) => {
      const def = byId(inst.id);
      if (!def) return;
      const p = { ...defaults(def), ...inst.params };
      const paneIdx = def.target === "pane" ? panes.get(inst.id).paneIndex() : 0;
      const visible = inst.hidden !== true;
      let rec = store.get(inst.iid);

      if (!rec) {
        const seriesByKey = new Map();
        seriesOutputs(def).forEach((o) => {
          const type = o.type === "histogram" ? lib.HistogramSeries : lib.LineSeries;
          seriesByKey.set(o.key, chart.addSeries(type, {}, paneIdx));
        });
        rec = { seriesByKey, markersByKey: new Map(), primByKey: new Map(), guided: false };
        store.set(inst.iid, rec);
      }

      const vals = candles && candles.length ? def.compute(candles, p) : null;

      // 3-1) 선 · 히스토그램
      seriesOutputs(def).forEach((o) => {
        const s = rec.seriesByKey.get(o.key);
        if (!s) return;
        // 창을 지우면 뒤 창의 인덱스가 밀린다. 매번 다시 맞춰준다.
        try { s.moveToPane(paneIdx); } catch { /* 무시 */ }
        const opts = { visible, priceLineVisible: false, lastValueVisible: false };
        const col = o.colorParam ? p[o.colorParam] : p.color;   // 다중 출력(볼린저·MACD)은 출력별 색
        if (col) opts.color = col;
        const w = p.width || o.width;
        if (w) opts.lineWidth = w;
        if (o.type === "histogram") opts.priceFormat = { type: "volume" };
        s.applyOptions(opts);
        if (vals) s.setData(vals[o.key] || []);
      });

      // 3-2) 마커 — 가격 위 지표는 캔들 시리즈에, 보조 창 지표는 자기 첫 시리즈에 붙인다
      const anchor = def.target === "pane"
        ? rec.seriesByKey.values().next().value
        : seriesRef.current;
      outputsOfType(def, "markers").forEach((o) => {
        if (!anchor) return;
        let plug = rec.markersByKey.get(o.key);
        if (!plug) {
          plug = lib.createSeriesMarkers(anchor, []);
          rec.markersByKey.set(o.key, plug);
        }
        plug.setMarkers(visible && vals ? (vals[o.key] || []) : []);
      });

      // 3-3) 프리미티브 (채널 채우기 · 존 박스 · 볼륨 프로파일 · 도형)
      primitiveOutputs(def).forEach((o) => {
        if (!anchor) return;
        let prim = rec.primByKey.get(o.key);
        if (!prim) {
          prim = new PRIMITIVE_TYPES[o.type]();
          anchor.attachPrimitive(prim);
          rec.primByKey.set(o.key, prim);
        }
        prim.setData(visible && vals ? (vals[o.key] ?? null) : null);
      });

      // 3-4) 캔들 색칠
      const barOuts = outputsOfType(def, "barcolor");
      if (barOuts.length) {
        const m = new Map();
        if (visible && vals) {
          barOuts.forEach((o) => (vals[o.key] || []).forEach((b) => m.set(b.time, b.color)));
        }
        if (m.size) barColorRef.current.set(inst.iid, m);
        else barColorRef.current.delete(inst.iid);
      }

      // 3-5) 상태 표
      outputsOfType(def, "dash").forEach((o) => {
        const rows = visible && vals ? (vals[o.key] || []) : [];
        if (rows.length) nextDashes.push({ iid: inst.iid, name: def.short, rows });
      });

      // 기준선 (RSI 70/30 등) — 인스턴스당 1회만
      if (!rec.guided && def.guides) {
        const first = seriesOutputs(def)[0];
        const s = first && rec.seriesByKey.get(first.key);
        if (s) {
          def.guides.forEach((g) => s.createPriceLine({
            price: g.value, color: g.color, lineWidth: 1,
            lineStyle: lib.LineStyle.Dashed, axisLabelVisible: false,
          }));
          rec.guided = true;
        }
      }
    });

    setDashes(nextDashes);

    // 4) 캔들 색이 붙거나 떨어졌으면 캔들을 다시 그린다
    if (barColorRef.current.size > 0 || barsBefore > 0) paintCandles();

    // 5) 높이 — 가격 창은 그대로 두고 전체를 늘린다 (전체화면에선 뷰포트가 정한다)
    const total = CHART_HEIGHT + panes.size * SUB_PANE_H;
    totalHRef.current = total;
    setTotalH(total);
    sizeRef.current = { w: 0, h: 0 };   // 강제로 다시 적용
    applySize();
  }, [instances, dataVersion, chartReady, applySize, paintCandles]);

  /* ── 지표: 마지막 봉만 실시간 갱신 ──────────────── */
  useEffect(() => {
    const candles = candlesRef.current;
    if (!chartRef.current || !candles || candles.length === 0 || !(cp > 0)) return;
    indRef.current.forEach((rec, iid) => {
      const inst = instances.find((x) => x.iid === iid);
      const def = inst && byId(inst.id);
      if (!def || inst.hidden === true) return;
      // 틱마다 갱신할 것이 없는 지표(존 박스·볼륨 프로파일)는 계산 자체를 건너뛴다.
      // 이쪽은 캔들을 새로 받을 때(dataVersion) 다시 그려진다.
      if (seriesOutputs(def).length === 0 && outputsOfType(def, "barcolor").length === 0) return;
      const vals = def.compute(candles, { ...defaults(def), ...inst.params });
      seriesOutputs(def).forEach((o) => {
        const arr = vals[o.key], s = rec.seriesByKey.get(o.key);
        if (!s || !arr || !arr.length) return;
        const last = arr[arr.length - 1];
        if (last.value === undefined) return;   // whitespace(추세 전환 틈)는 건너뛴다
        try { s.update(last); } catch { /* 무시 */ }
      });
      // 마지막 봉 색만 갱신 (전량 setData 는 비싸고 깜빡인다)
      const barOuts = outputsOfType(def, "barcolor");
      if (barOuts.length) {
        const m = barColorRef.current.get(iid);
        if (m) barOuts.forEach((o) => {
          const arr = vals[o.key];
          if (arr && arr.length) m.set(arr[arr.length - 1].time, arr[arr.length - 1].color);
        });
      }
    });
  }, [cp]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 전체화면 ───────────────────────────────────
     CSS 고정 오버레이가 본체다. 네이티브 Fullscreen API 는 위에 얹어
     브라우저 UI 까지 숨기되, 실패하는 환경(iOS Safari)에서도 오버레이는 그대로 뜬다.
     차트 인스턴스는 재생성하지 않으므로 캔들 재요청·확대 상태가 유지된다. */
  useEffect(() => { fullRef.current = isFull; applySize(); }, [isFull, applySize]);

  /* 종료 경로는 반드시 하나로 묶는다.
     오버레이만 닫고 네이티브 전체화면을 그대로 두면, 화면은 전체화면인데
     카드는 원래 크기로 돌아가 레이아웃이 깨진 채로 남는다. */
  const exitFull = useCallback(() => {
    if (typeof document !== "undefined" && document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => { /* 무시 */ });
    }
    setIsFull(false);
  }, []);

  // setState 갱신자 안에서 부수효과를 내면 StrictMode 에서 두 번 실행된다. 밖에서 처리한다.
  const toggleFull = useCallback(() => {
    if (fullRef.current) { exitFull(); return; }
    boxRef.current?.requestFullscreen?.().catch(() => { /* 실패해도 오버레이는 뜬다 */ });
    setIsFull(true);
  }, [exitFull]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    // 네이티브 전체화면을 브라우저 쪽에서(ESC·F11) 빠져나가면 오버레이도 같이 닫는다
    const onFsChange = () => { if (!document.fullscreenElement) setIsFull(false); };
    // 네이티브가 없는 환경(iOS Safari)에서도 ESC 로 닫히게 한다
    const onKey = (e) => { if (e.key === "Escape") exitFull(); };
    document.addEventListener("fullscreenchange", onFsChange);
    if (isFull) document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("keydown", onKey);
    };
  }, [isFull, exitFull]);

  /* ── 지표 조작 ──────────────────────────────────── */
  const addIndicator = (id) => {
    const def = byId(id);
    if (!def) return;
    if (def.target === "pane") {
      const used = new Set(instances.filter((i) => byId(i.id)?.target === "pane").map((i) => i.id));
      if (!used.has(id) && used.size >= MAX_SUB_PANES) return;   // 창 상한
    }
    const params = defaults(def);
    // 같은 지표를 또 얹으면 기본색이 겹쳐 구분이 안 된다. 색을 돌려 쓴다.
    const dup = instances.filter((i) => i.id === id).length;
    if (dup > 0 && def.params.some((pr) => pr.key === "color")) {
      params.color = INSTANCE_PALETTE[dup % INSTANCE_PALETTE.length];
    }
    setInstances((a) => [...a, { iid: nextIid(), id, params }]);
    setPickerOpen(false); setPickerQuery("");
  };
  const removeIndicator = (iid) => {
    setInstances((a) => a.filter((x) => x.iid !== iid));
    setSettingIid((s) => (s === iid ? null : s));
  };
  const toggleHidden = (iid) =>
    setInstances((a) => a.map((x) => (x.iid === iid ? { ...x, hidden: !x.hidden } : x)));
  const setParam = (iid, key, val) =>
    setInstances((a) => a.map((x) => (x.iid === iid ? { ...x, params: { ...x.params, [key]: val } } : x)));

  const paneCount = new Set(instances.filter((i) => byId(i.id)?.target === "pane").map((i) => i.id)).size;
  const settingInst = instances.find((x) => x.iid === settingIid) || null;
  const settingDef = settingInst ? byId(settingInst.id) : null;

  /* ── 렌더 ───────────────────────────────────────── */
  const tabBtn = (active, color) => ({
    padding: "4px 10px", fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: "pointer",
    fontFamily: "'DM Sans'", transition: "all 0.15s",
    border: `1px solid ${active ? color + "66" : "var(--border)"}`,
    background: active ? color + "15" : "transparent",
    color: active ? color : "var(--text-dim)",
  });

  const outerStyle = isFull
    ? {
        position: "fixed", inset: 0, zIndex: 250, margin: 0, borderRadius: 0,
        padding: 12, background: "var(--bg-card)", border: "none",
        display: "flex", flexDirection: "column", gap: 0,
      }
    : {
        marginBottom: 16, padding: 12, borderRadius: 10,
        background: "var(--bg-card)", border: "1px solid var(--border)",
      };

  return (
    <div ref={boxRef} style={outerStyle}>
      {/* 코인 탭 + 봉 간격 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {coins.map((c) => (
          <button key={c} onClick={() => setCoin(c)} style={{ ...tabBtn(coin === c, "#0ea5e9"), fontFamily: "'IBM Plex Mono'" }}>{c}</button>
        ))}
        <div style={{ flex: 1 }} />
        {INTERVALS.map((i) => (
          <button key={i.id} onClick={() => setItv(i.id)} style={tabBtn(itv === i.id, "#8b8ba7")}>{i.label}</button>
        ))}
        <button onClick={toggleFull} title={isFull ? "전체화면 종료 (ESC)" : "전체화면"}
          style={{ ...tabBtn(isFull, "#0ea5e9"), padding: "4px 8px", fontSize: 12 }}>
          {isFull ? "⤡" : "⤢"}
        </button>
      </div>

      {/* 토글 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        {[
          { on: showLiq, set: setShowLiq, label: "강청가", c: LIQ },
          { on: showBe, set: setShowBe, label: "손익분기점", c: BE },
        ].map((t) => (
          <label key={t.label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, cursor: "pointer", color: t.on ? t.c : "var(--text-dim)", fontFamily: "'DM Sans'", userSelect: "none" }}>
            <input type="checkbox" checked={t.on} onChange={(e) => t.set(e.target.checked)} style={{ accentColor: t.c, cursor: "pointer" }} />
            {t.label}
          </label>
        ))}
        {/* 지표 추가 */}
        <div style={{ position: "relative" }}>
          <button onClick={() => setPickerOpen((v) => !v)} style={{
            padding: "3px 10px", fontSize: 10, fontWeight: 700, borderRadius: 6, cursor: "pointer",
            fontFamily: "'DM Sans'",
            border: `1px solid ${pickerOpen ? "#0ea5e966" : "var(--border)"}`,
            background: pickerOpen ? "#0ea5e915" : "transparent",
            color: pickerOpen ? "#0ea5e9" : "var(--text-muted)",
          }}>＋ 지표</button>
          {pickerOpen && (
            <div style={{
              position: "absolute", top: 26, left: 0, zIndex: 20, width: 250,
              background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
              boxShadow: "0 8px 24px #0008", padding: 8,
            }}>
              <input autoFocus value={pickerQuery} onChange={(e) => setPickerQuery(e.target.value)} placeholder="지표 검색"
                style={{ width: "100%", padding: "5px 8px", marginBottom: 6, background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-bright)", fontSize: 11, fontFamily: "'DM Sans'", outline: "none" }} />
              <div style={{ maxHeight: 280, overflowY: "auto" }}>
                {CATEGORIES.map((cat) => {
                  const items = REGISTRY.filter((r) => r.category === cat &&
                    (r.name + r.short).toLowerCase().includes(pickerQuery.trim().toLowerCase()));
                  if (items.length === 0) return null;
                  return (
                    <div key={cat} style={{ marginBottom: 4 }}>
                      <div style={{ fontSize: 9, color: "var(--text-dim)", padding: "3px 4px", letterSpacing: 1 }}>{cat}</div>
                      {items.map((r) => {
                        const full = r.target === "pane" && paneCount >= MAX_SUB_PANES &&
                          !instances.some((i) => i.id === r.id);
                        return (
                          <div key={r.id} onClick={() => !full && addIndicator(r.id)} style={{
                            display: "flex", justifyContent: "space-between", alignItems: "center",
                            padding: "5px 6px", borderRadius: 5, fontSize: 11, fontFamily: "'DM Sans'",
                            cursor: full ? "not-allowed" : "pointer",
                            color: full ? "var(--text-dim)" : "var(--text-secondary)",
                          }}
                            onMouseEnter={(e) => { if (!full) e.currentTarget.style.background = "var(--bg-hover)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                            <span>{r.name}</span>
                            <span style={{ fontSize: 9, color: "var(--text-dim)" }}>
                              {full ? "창 상한" : r.target === "pane" ? "별도 창" : "가격 위"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "'DM Sans'" }}>Binance 선물 · KST</span>
      </div>

      {/* 차트 */}
      <div ref={areaRef} style={{
        position: "relative",
        ...(isFull ? { flex: 1, minHeight: 0, overflow: "hidden" } : {}),
      }}>
        <div ref={wrapRef} style={{ width: "100%", height: isFull ? "100%" : totalH }} />

        {/* 범례 — 적용된 지표 인스턴스 */}
        {instances.length > 0 && (
          <div style={{ position: "absolute", top: 6, left: 8, zIndex: 3, display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}>
            {instances.map((inst) => {
              const def = byId(inst.id);
              if (!def) return null;
              const p = { ...defaults(def), ...inst.params };
              const dim = inst.hidden === true;
              const swatch = def.legendColor ? def.legendColor(p) : (p.color || p.up || "#8b8ba7");
              return (
                <div key={inst.iid} style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "2px 6px",
                  background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 5,
                  fontSize: 10, fontFamily: "'DM Sans'", opacity: dim ? 0.45 : 1,
                }}>
                  <span style={{ width: 9, height: 2, borderRadius: 1, background: swatch }} />
                  <span style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{def.label(p)}</span>
                  {[
                    { t: dim ? "표시" : "숨김", on: () => toggleHidden(inst.iid), c: "👁" },
                    { t: "설정", on: () => setSettingIid(inst.iid === settingIid ? null : inst.iid), c: "⚙" },
                    { t: "삭제", on: () => removeIndicator(inst.iid), c: "✕" },
                  ].map((b) => (
                    <button key={b.t} title={b.t} onClick={b.on} style={{
                      background: "none", border: "none", padding: 0, cursor: "pointer",
                      fontSize: 9, lineHeight: 1, color: "var(--text-dim)",
                    }}>{b.c}</button>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {/* 지표 상태 표 — 지표별로 카드를 따로 띄우면 3~4개만 켜도 차트를 다 가린다.
            한 패널로 합치고 접을 수 있게 한다. 접힘 여부는 취향이라 전역 저장. */}
        {dashes.length > 0 && (
          <div style={{
            position: "absolute", bottom: 28, right: 60, zIndex: 3,
            display: "flex", flexDirection: "column", alignItems: "flex-end",
            fontFamily: "'DM Sans'", pointerEvents: "none",
          }}>
            {dashOpen ? (
              <div style={{
                background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6,
                boxShadow: "0 4px 12px #0006", minWidth: 148, overflow: "hidden",
              }}>
                <button onClick={() => setDashOpen(false)} title="접기" style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                  width: "100%", padding: "3px 8px", cursor: "pointer", pointerEvents: "auto",
                  background: "var(--bg-hover)", border: "none", borderBottom: "1px solid var(--border)",
                  fontSize: 8, letterSpacing: 1, color: "var(--text-dim)", fontFamily: "'DM Sans'",
                }}>
                  <span>지표 {dashes.length}</span>
                  <span style={{ fontSize: 9 }}>▾</span>
                </button>
                <div style={{ padding: "4px 8px 5px" }}>
                  {dashes.map((d, di) => (
                    <div key={d.iid} style={{
                      marginTop: di === 0 ? 0 : 4, paddingTop: di === 0 ? 0 : 4,
                      borderTop: di === 0 ? "none" : "1px solid var(--border)",
                    }}>
                      <div style={{ fontSize: 8, color: "var(--text-dim)", letterSpacing: 1, marginBottom: 1 }}>{d.name}</div>
                      {d.rows.map((r) => (
                        <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 9, lineHeight: 1.6 }}>
                          <span style={{ color: "var(--text-dim)" }}>{r.label}</span>
                          <span style={{ color: r.color || "var(--text-secondary)", fontWeight: 600, fontFamily: "'IBM Plex Mono'" }}>{r.value}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <button onClick={() => setDashOpen(true)} title="지표 상태 표 펼치기" style={{
                display: "flex", alignItems: "center", gap: 5, padding: "3px 8px", cursor: "pointer",
                pointerEvents: "auto", borderRadius: 6,
                background: "var(--bg-card)", border: "1px solid var(--border)",
                boxShadow: "0 4px 12px #0006",
                fontSize: 9, letterSpacing: 1, color: "var(--text-dim)", fontFamily: "'DM Sans'",
              }}>
                지표 {dashes.length} <span style={{ fontSize: 9 }}>▴</span>
              </button>
            )}
          </div>
        )}

        {/* 지표 설정 */}
        {settingInst && settingDef && (
          <div style={{
            position: "absolute", top: 6, left: 200, zIndex: 21, width: 230,
            maxHeight: "calc(100% - 24px)", overflowY: "auto",
            background: "var(--bg-card)", border: "1px solid #0ea5e944", borderRadius: 8,
            boxShadow: "0 8px 24px #0008", padding: 10,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, position: "sticky", top: 0, background: "var(--bg-card)" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#0ea5e9", fontFamily: "'DM Sans'" }}>{settingDef.name} 설정</span>
              <button onClick={() => setSettingIid(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 11, padding: 0 }}>✕</button>
            </div>
            {settingDef.params.map((pr) => {
              const cur = settingInst.params?.[pr.key] ?? pr.def;
              const inputStyle = {
                width: 110, padding: "3px 6px", background: "var(--bg-input)",
                border: "1px solid var(--border)", borderRadius: 5,
                color: "var(--text-bright)", fontSize: 10, outline: "none",
              };
              return (
                <div key={pr.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "'DM Sans'" }}>{pr.label}</span>
                  {pr.type === "select" ? (
                    <select value={cur} onChange={(e) => setParam(settingInst.iid, pr.key, e.target.value)} style={inputStyle}>
                      {pr.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : pr.type === "color" ? (
                    <input type="color" value={String(cur).slice(0, 7)} onChange={(e) => setParam(settingInst.iid, pr.key, e.target.value)}
                      style={{ ...inputStyle, height: 22, padding: 0, background: "none", cursor: "pointer" }} />
                  ) : pr.type === "bool" ? (
                    <input type="checkbox" checked={cur === true} onChange={(e) => setParam(settingInst.iid, pr.key, e.target.checked)}
                      style={{ width: 110, accentColor: "#0ea5e9", cursor: "pointer", marginRight: "auto", marginLeft: 0 }} />
                  ) : (
                    <input type="number" value={cur} min={pr.min} max={pr.max} step={pr.type === "float" ? (pr.step ?? 0.1) : 1}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === "" || raw === "-") return;
                        const v = Number(raw);
                        if (!isFinite(v)) return;
                        const q = pr.type === "float" ? v : Math.round(v);
                        setParam(settingInst.iid, pr.key, Math.min(pr.max ?? q, Math.max(pr.min ?? q, q)));
                      }}
                      style={{ ...inputStyle, fontFamily: "'IBM Plex Mono'" }} />
                  )}
                </div>
              );
            })}
          </div>
        )}
        {status !== "ok" && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--bg-card)", fontSize: 11, color: "var(--text-dim)", fontFamily: "'DM Sans'",
          }}>
            {status === "loading" ? "캔들 불러오는 중…"
              : status === "nodata" ? `${coin} 은(는) Binance 선물에 없어 캔들을 표시할 수 없습니다`
              : "캔들을 불러오지 못했습니다"}
          </div>
        )}
      </div>

      {/* 범위 밖 선 */}
      {offscreen.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
          {offscreen.map((l) => (
            <span key={l.key} style={{ fontSize: 9, color: l.color, fontFamily: "'DM Sans'" }}>
              {l.above ? "▲" : "▼"} {l.title} {fmtNum(l.price, l.price > 100 ? 2 : 4)}
              <span style={{ color: "var(--text-dim)" }}> ({l.pct >= 0 ? "+" : ""}{fmtNum(l.pct, 1)}% · 범위 밖)</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
