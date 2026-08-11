"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { REGISTRY, CATEGORIES, byId, defaults } from "./indicators";

/* ═══════════════════════════════════════════
   POSITION CHART
   Binance 캔들 + 회원 포지션 가로선
   ═══════════════════════════════════════════ */

const INTERVALS = [
  { id: "5m", label: "5분" },
  { id: "15m", label: "15분" },
  { id: "1h", label: "1시간" },
  { id: "4h", label: "4시간" },
  { id: "1d", label: "일봉" },
];

// lightweight-charts 는 시간축을 항상 UTC 로 그린다. 타임스탬프를 미리 밀어
// 표시값이 KST 가 되게 한다 (라이브러리에 타임존 옵션이 없다).
const KST_SHIFT = 9 * 3600;

const KLINE_REFRESH_MS = 30000;

// 자동 축소에 포함할 선의 범위. 헷지 포지션은 강청가가 현재가의 17배 같은
// 값으로 나올 수 있는데, 그대로 넣으면 캔들이 한 줄로 눌린다.
const SCALE_MIN = 0.5;
const SCALE_MAX = 2;

const CHART_HEIGHT = 480;      // 가격 창 (지표를 켜도 줄지 않는다)
const SUB_PANE_H = 90;         // 보조 창 하나당 높이 — 전체 차트가 세로로 늘어난다
const MAX_SUB_PANES = 3;
const STORE_KEY = "cs-chart-indicators";   // 보는 사람 취향이라 회원과 무관하게 전역 저장

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

export default function PositionChart({ coins, positions, liqPerCoin, fee, theme, livePrices, simOverlay }) {
  const [coin, setCoin] = useState(coins[0] || "");
  const [itv, setItv] = useState("15m");
  const [showLiq, setShowLiq] = useState(true);
  const [showBe, setShowBe] = useState(false);
  const [status, setStatus] = useState("loading"); // loading | ok | nodata | error
  const [offscreen, setOffscreen] = useState([]);  // 범위 밖이라 못 그린 선들

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

  const wrapRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const libRef = useRef(null);
  const linesRef = useRef(new Map());     // key -> { line, price, color, style, title }
  const scalePricesRef = useRef([]);      // autoscale 에 포함할 가격들
  const candlesRef = useRef(null);
  const cacheRef = useRef(new Map());     // `${coin}:${itv}` -> candles
  const tokenRef = useRef(0);             // 코인/봉간격 전환 레이스 가드
  const keyRef = useRef("");              // 현재 코인·봉간격
  const fitKeyRef = useRef("");           // 전체 보기를 이미 맞춘 조합
  const wheelCleanupRef = useRef(null);
  const indRef = useRef(new Map());       // iid -> { seriesByKey: Map, guides: [] }
  const paneRef = useRef(new Map());      // indicatorId -> IPaneApi (같은 지표는 창 공유)
  const totalHRef = useRef(CHART_HEIGHT);

  const cp = coin ? Number(livePrices?.[coin] || 0) : 0;

  // 보유 코인이 바뀌면 현재 탭이 유효한지 확인
  const coinKey = coins.join(",");
  useEffect(() => {
    if (coins.length === 0) return;
    if (!coins.includes(coin)) setCoin(coins[0]);
  }, [coinKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

      ro = new ResizeObserver(() => {
        if (!chartRef.current || !wrapRef.current) return;
        chartRef.current.resize(wrapRef.current.clientWidth, totalHRef.current);
      });
      ro.observe(wrapRef.current);

      setChartReady((v) => v + 1);   // 지표 반영 effect 를 깨운다
    })();

    return () => {
      disposed = true;
      if (ro) ro.disconnect();
      if (wheelCleanupRef.current) { wheelCleanupRef.current(); wheelCleanupRef.current = null; }
      linesRef.current.clear();
      indRef.current.clear();
      paneRef.current.clear();
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

  /* ── 캔들 로딩 ──────────────────────────────────── */
  useEffect(() => {
    if (!coin) return;
    const token = ++tokenRef.current;
    const ctrl = new AbortController();
    const key = `${coin}:${itv}`;
    keyRef.current = key;

    const paint = (candles) => {
      if (token !== tokenRef.current) return;  // 늦게 온 응답이 최신을 덮어쓰지 않도록
      candlesRef.current = candles;
      setDataVersion((v) => v + 1);   // 지표 재계산 트리거
      setStatus("ok");
      const s = seriesRef.current;
      if (!s) return;                          // 차트가 아직 준비 전이면 생성 시점에 그린다
      s.setData(candles);
      // 전체 보기는 코인·봉간격이 바뀐 직후 1회만.
      // 30초 갱신마다 부르면 사용자가 확대해둔 것이 계속 풀린다.
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
    const timer = setInterval(load, KLINE_REFRESH_MS);
    return () => { ctrl.abort(); clearInterval(timer); };
  }, [coin, itv]);

  /* ── 마지막 봉 실시간 갱신 (3초 시세) ───────────── */
  useEffect(() => {
    const s = seriesRef.current;
    const c = candlesRef.current;
    if (!s || !c || c.length === 0 || !(cp > 0)) return;
    const last = c[c.length - 1];
    last.close = cp;
    if (cp > last.high) last.high = cp;
    if (cp < last.low) last.low = cp;
    s.update(last);   // setData 재호출은 정렬 검증에 걸린다. 마지막 봉만 update.
  }, [cp]);

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

  /* ── 지표: 시리즈·창 반영 ───────────────────────── */
  useEffect(() => {
    const chart = chartRef.current, lib = libRef.current;
    if (!chart || !lib) return;
    const candles = candlesRef.current;
    const store = indRef.current;
    const panes = paneRef.current;

    // 1) 사라진 인스턴스의 시리즈 제거 (창보다 먼저 지워야 빈 창을 지울 수 있다)
    [...store.keys()].forEach((iid) => {
      if (instances.some((x) => x.iid === iid)) return;
      store.get(iid).seriesByKey.forEach((s) => { try { chart.removeSeries(s); } catch { /* 이미 제거됨 */ } });
      store.delete(iid);
    });

    // 2) 창 확보 / 정리 — 같은 지표 id 는 한 창을 공유한다
    const wantPanes = [...new Set(instances.filter((i) => byId(i.id)?.target === "pane").map((i) => i.id))];
    [...panes.keys()].forEach((k) => {
      if (wantPanes.includes(k)) return;
      try { chart.removePane(panes.get(k).paneIndex()); } catch { /* 무시 */ }
      panes.delete(k);
    });
    wantPanes.forEach((k) => { if (!panes.has(k)) panes.set(k, chart.addPane()); });

    // 3) 시리즈 생성 / 옵션·데이터 갱신
    instances.forEach((inst) => {
      const def = byId(inst.id);
      if (!def) return;
      const p = { ...defaults(def), ...inst.params };
      const paneIdx = def.target === "pane" ? panes.get(inst.id).paneIndex() : 0;
      let rec = store.get(inst.iid);

      if (!rec) {
        const seriesByKey = new Map();
        def.outputs.forEach((o) => {
          const type = o.type === "histogram" ? lib.HistogramSeries : lib.LineSeries;
          seriesByKey.set(o.key, chart.addSeries(type, {}, paneIdx));
        });
        rec = { seriesByKey, guided: false };
        store.set(inst.iid, rec);
      }

      def.outputs.forEach((o) => {
        const s = rec.seriesByKey.get(o.key);
        if (!s) return;
        // 창을 지우면 뒤 창의 인덱스가 밀린다. 매번 다시 맞춰준다.
        try { s.moveToPane(paneIdx); } catch { /* 무시 */ }
        const opts = { visible: inst.hidden !== true, priceLineVisible: false, lastValueVisible: false };
        const col = o.colorParam ? p[o.colorParam] : p.color;   // 다중 출력(볼린저·MACD)은 출력별 색
        if (col) opts.color = col;
        if (p.width) opts.lineWidth = p.width;
        if (o.type === "histogram") opts.priceFormat = { type: "volume" };
        s.applyOptions(opts);
        if (candles && candles.length) s.setData(def.compute(candles, p)[o.key] || []);
      });

      // 기준선 (RSI 70/30 등) — 인스턴스당 1회만
      if (!rec.guided && def.guides) {
        const s = rec.seriesByKey.get(def.outputs[0].key);
        if (s) {
          def.guides.forEach((g) => s.createPriceLine({
            price: g.value, color: g.color, lineWidth: 1,
            lineStyle: lib.LineStyle.Dashed, axisLabelVisible: false,
          }));
          rec.guided = true;
        }
      }
    });

    // 4) 높이 — 가격 창은 그대로 두고 전체를 늘린다
    const total = CHART_HEIGHT + panes.size * SUB_PANE_H;
    totalHRef.current = total;
    setTotalH(total);
    if (wrapRef.current) chart.resize(wrapRef.current.clientWidth, total);
    chart.panes().forEach((pane, i) => { if (i > 0) { try { pane.setHeight(SUB_PANE_H); } catch { /* 무시 */ } } });
  }, [instances, dataVersion, chartReady]);

  /* ── 지표: 마지막 봉만 실시간 갱신 ──────────────── */
  useEffect(() => {
    const candles = candlesRef.current;
    if (!chartRef.current || !candles || candles.length === 0 || !(cp > 0)) return;
    indRef.current.forEach((rec, iid) => {
      const inst = instances.find((x) => x.iid === iid);
      const def = inst && byId(inst.id);
      if (!def) return;
      const vals = def.compute(candles, { ...defaults(def), ...inst.params });
      def.outputs.forEach((o) => {
        const arr = vals[o.key], s = rec.seriesByKey.get(o.key);
        if (s && arr && arr.length) { try { s.update(arr[arr.length - 1]); } catch { /* 무시 */ } }
      });
    });
  }, [cp]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
    <div style={{ marginBottom: 16, padding: 12, borderRadius: 10, background: "var(--bg-card)", border: "1px solid var(--border)" }}>
      {/* 코인 탭 + 봉 간격 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {coins.map((c) => (
          <button key={c} onClick={() => setCoin(c)} style={{ ...tabBtn(coin === c, "#0ea5e9"), fontFamily: "'IBM Plex Mono'" }}>{c}</button>
        ))}
        <div style={{ flex: 1 }} />
        {INTERVALS.map((i) => (
          <button key={i.id} onClick={() => setItv(i.id)} style={tabBtn(itv === i.id, "#8b8ba7")}>{i.label}</button>
        ))}
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
              position: "absolute", top: 26, left: 0, zIndex: 20, width: 230,
              background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
              boxShadow: "0 8px 24px #0008", padding: 8,
            }}>
              <input autoFocus value={pickerQuery} onChange={(e) => setPickerQuery(e.target.value)} placeholder="지표 검색"
                style={{ width: "100%", padding: "5px 8px", marginBottom: 6, background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-bright)", fontSize: 11, fontFamily: "'DM Sans'", outline: "none" }} />
              <div style={{ maxHeight: 240, overflowY: "auto" }}>
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
      <div style={{ position: "relative" }}>
        <div ref={wrapRef} style={{ width: "100%", height: totalH }} />

        {/* 범례 — 적용된 지표 인스턴스 */}
        {instances.length > 0 && (
          <div style={{ position: "absolute", top: 6, left: 8, zIndex: 3, display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}>
            {instances.map((inst) => {
              const def = byId(inst.id);
              if (!def) return null;
              const p = { ...defaults(def), ...inst.params };
              const dim = inst.hidden === true;
              return (
                <div key={inst.iid} style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "2px 6px",
                  background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 5,
                  fontSize: 10, fontFamily: "'DM Sans'", opacity: dim ? 0.45 : 1,
                }}>
                  <span style={{ width: 9, height: 2, borderRadius: 1, background: p.color || p.up || "#8b8ba7" }} />
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

        {/* 지표 설정 */}
        {settingInst && settingDef && (
          <div style={{
            position: "absolute", top: 6, left: 200, zIndex: 21, width: 210,
            background: "var(--bg-card)", border: "1px solid #0ea5e944", borderRadius: 8,
            boxShadow: "0 8px 24px #0008", padding: 10,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#0ea5e9", fontFamily: "'DM Sans'" }}>{settingDef.name} 설정</span>
              <button onClick={() => setSettingIid(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 11, padding: 0 }}>✕</button>
            </div>
            {settingDef.params.map((pr) => {
              const cur = settingInst.params?.[pr.key] ?? pr.def;
              return (
                <div key={pr.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "'DM Sans'" }}>{pr.label}</span>
                  {pr.type === "select" ? (
                    <select value={cur} onChange={(e) => setParam(settingInst.iid, pr.key, e.target.value)}
                      style={{ width: 110, padding: "3px 6px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-bright)", fontSize: 10, outline: "none" }}>
                      {pr.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : pr.type === "color" ? (
                    <input type="color" value={String(cur).slice(0, 7)} onChange={(e) => setParam(settingInst.iid, pr.key, e.target.value)}
                      style={{ width: 110, height: 22, padding: 0, background: "none", border: "1px solid var(--border)", borderRadius: 5, cursor: "pointer" }} />
                  ) : (
                    <input type="number" value={cur} min={pr.min} max={pr.max}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!isFinite(v)) return;
                        setParam(settingInst.iid, pr.key, Math.min(pr.max ?? v, Math.max(pr.min ?? v, Math.round(v))));
                      }}
                      style={{ width: 110, padding: "3px 6px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-bright)", fontSize: 10, fontFamily: "'IBM Plex Mono'", outline: "none" }} />
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
