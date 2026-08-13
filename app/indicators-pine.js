/* ═══════════════════════════════════════════
   TradingView Pine Script 이식 지표

   1단계: SSL Hybrid (Mihkel00) · SuperTrend AI Clustering (LuxAlgo)
   2단계 예정: Volume Profile Fixed Range · FluidTrades SMC Lite (박스 프리미티브 필요)

   원본과 값이 어긋나면 안 되므로 수식은 Pine 을 그대로 따라간다.
   의도적으로 다르게 한 곳은 전부 주석으로 이유를 남겼다.
   ═══════════════════════════════════════════ */

import {
  ma, maWarmup, MA_OPTIONS, atr, trueRange, ema, rma, percentRank,
  pickSrc, SRC_OPTIONS, toPoints, withAlpha, nz,
} from "./ta";

const SMOOTHING_OPTIONS = ["RMA", "SMA", "EMA", "WMA"].map((v) => ({ value: v, label: v }));
const NEUTRAL = "#666666";

/* ═══════════════════════════════════════════
   ① SSL Hybrid
   ═══════════════════════════════════════════ */

const DISPLAY_OPTIONS = [
  { value: "full", label: "전체" },
  { value: "baseline", label: "베이스라인만" },
  { value: "baseline_ssl", label: "베이스라인+SSL" },
  { value: "ssl", label: "SSL만" },
  { value: "exit", label: "청산선만" },
];

export const SSL_HYBRID = {
  id: "ssl_hybrid",
  name: "SSL Hybrid",
  short: "SSL",
  category: "추세",
  target: "price",
  params: [
    { key: "display", label: "표시 범위", type: "select", def: "full", options: DISPLAY_OPTIONS },

    { key: "maType", label: "베이스라인 종류", type: "select", def: "HMA", options: MA_OPTIONS },
    { key: "len", label: "베이스라인 기간", type: "int", def: 60, min: 1, max: 500 },
    { key: "src", label: "소스", type: "select", def: "close", options: SRC_OPTIONS },
    { key: "showChannel", label: "채널 표시", type: "bool", def: true },
    { key: "multy", label: "채널 배수", type: "float", def: 0.2, min: 0, max: 5, step: 0.05 },
    { key: "useTrueRange", label: "채널에 TR 사용", type: "bool", def: true },

    { key: "ssl2Type", label: "SSL2 종류", type: "select", def: "JMA", options: MA_OPTIONS },
    { key: "len2", label: "SSL2 기간", type: "int", def: 5, min: 1, max: 500 },
    { key: "atrCrit", label: "연속성 ATR 기준", type: "float", def: 0.9, min: 0, max: 10, step: 0.1 },

    { key: "ssl3Type", label: "청산선 종류", type: "select", def: "HMA", options: MA_OPTIONS },
    { key: "len3", label: "청산선 기간", type: "int", def: 15, min: 1, max: 500 },

    { key: "atrlen", label: "ATR 기간", type: "int", def: 14, min: 1, max: 200 },
    { key: "mult", label: "ATR 배수", type: "float", def: 1.0, min: 0.1, max: 10, step: 0.1 },
    { key: "smoothing", label: "ATR 평활", type: "select", def: "WMA", options: SMOOTHING_OPTIONS },
    { key: "showAtrBands", label: "ATR 밴드 표시", type: "bool", def: false },

    { key: "bull", label: "상승 색", type: "color", def: "#00c3ff" },
    { key: "bear", label: "하락 색", type: "color", def: "#ff0062" },
    { key: "colorBars", label: "캔들 색칠", type: "bool", def: true },
    { key: "showSignals", label: "경고 마커", type: "bool", def: true },
    { key: "showTable", label: "리스크 표", type: "bool", def: true },

    { key: "riskGradient", label: "리스크 그라데이션", type: "bool", def: true },
    { key: "riskLookback", label: "리스크 관찰 기간", type: "int", def: 100, min: 50, max: 500 },
    { key: "riskSens", label: "리스크 민감도", type: "float", def: 2, min: 0.2, max: 3, step: 0.1 },

    { key: "jurikPhase", label: "JMA Phase", type: "int", def: 3, min: -100, max: 100 },
    { key: "jurikPower", label: "JMA Power", type: "int", def: 1, min: 1, max: 10 },
    { key: "kidiv", label: "Kijun 분할", type: "int", def: 1, min: 1, max: 4 },
  ],
  outputs: [
    { key: "fill", type: "band" },
    { key: "baseline", type: "line", width: 3 },
    { key: "upper", type: "line" },
    { key: "lower", type: "line" },
    { key: "ssl1", type: "line", width: 2 },
    { key: "ssl2", type: "line", width: 2 },
    { key: "atrUp", type: "line" },
    { key: "atrDn", type: "line" },
    { key: "exits", type: "markers" },
    { key: "warns", type: "shapes" },
    { key: "bars", type: "barcolor" },
    { key: "dash", type: "dash" },
  ],
  legendColor: (p) => p.bull,
  label: (p) => `SSL Hybrid ${p.maType} ${p.len}`,

  compute: (c, p) => {
    const n = c.length;
    const empty = { baseline: [], upper: [], lower: [], ssl1: [], ssl2: [], atrUp: [], atrDn: [], exits: [], warns: [], bars: [], dash: [] };
    if (n === 0) return empty;

    const maOpt = { jurikPhase: p.jurikPhase, jurikPower: p.jurikPower, kidiv: p.kidiv };
    const closeArr = c.map((x) => x.close);
    const srcArr = c.map((x) => pickSrc(x, p.src));
    const highArr = c.map((x) => x.high);
    const lowArr = c.map((x) => x.low);

    const atrS = atr(c, p.atrlen, p.smoothing);
    const upperBand = atrS.map((a, i) => (a == null ? null : a * p.mult + c[i].close));
    const lowerBand = atrS.map((a, i) => (a == null ? null : c[i].close - a * p.mult));

    /* ── 리스크 채도 (Pine risk_saturation) ── */
    const prank = percentRank(atrS, p.riskLookback);
    const satAt = (i) => {
      if (!p.riskGradient) return 0;
      const pr = prank[i];
      if (pr == null) return 0;
      const adj = Math.pow(pr / 100, p.riskSens) * 100;
      if (adj <= 25) return 0;
      if (adj <= 50) return 10;
      return Math.round(25 + ((adj - 50) / 50) * 25);
    };
    const bullAt = (i) => withAlpha(p.bull, satAt(i));
    const bearAt = (i) => withAlpha(p.bear, satAt(i));

    /* ── 베이스라인 · 채널 ── */
    const BBMC = ma(p.maType, c, closeArr, p.len, maOpt);
    const keltma = ma(p.maType, c, srcArr, p.len, maOpt);
    const rangeValue = p.useTrueRange ? trueRange(c) : c.map((x) => x.high - x.low);
    const rangema = ema(rangeValue, p.len);
    const upperk = keltma.map((k, i) => (k == null || rangema[i] == null ? null : k + rangema[i] * p.multy));
    const lowerk = keltma.map((k, i) => (k == null || rangema[i] == null ? null : k - rangema[i] * p.multy));

    /* ── SSL1 / SSL2 / 청산선 ── */
    const run = (type, len) => {
      const hi = ma(type, c, highArr, len, maOpt);
      const lo = ma(type, c, lowArr, len, maOpt);
      const out = new Array(n).fill(null);
      let hlv = null;
      for (let i = 0; i < n; i++) {
        if (hi[i] == null || lo[i] == null) continue;
        hlv = c[i].close > hi[i] ? 1 : c[i].close < lo[i] ? -1 : hlv;
        if (hlv == null) continue;
        out[i] = hlv < 0 ? hi[i] : lo[i];
      }
      return out;
    };
    const sslDown = run(p.maType, p.len);
    const sslDown2 = run(p.ssl2Type, p.len2);
    const sslExit = run(p.ssl3Type, p.len3);

    /* ── 워밍업: 쓰인 MA 중 가장 늦게 안정되는 것에 맞춘다 ──
       재귀 필터(JMA 등)를 안 자르면 첫 봉이 시세의 1/4 값으로 튀어
       가격축 전체가 뭉개진다. ta.js 상단 주석 참고. */
    const warmup = Math.min(n - 1, Math.max(
      maWarmup(p.maType, p.len),
      maWarmup(p.ssl2Type, p.len2),
      maWarmup(p.ssl3Type, p.len3),
      p.atrlen
    ));

    /* ── 색 ── */
    const baseColor = (i) =>
      upperk[i] == null ? NEUTRAL
        : c[i].close > upperk[i] ? bullAt(i)
        : c[i].close < lowerk[i] ? bearAt(i)
        : withAlpha(NEUTRAL, 0);
    const ssl1Color = (i) =>
      sslDown[i] == null ? NEUTRAL
        : c[i].close > sslDown[i] ? bullAt(i)
        : c[i].close < sslDown[i] ? bearAt(i)
        : withAlpha(NEUTRAL, 0);

    /* ── SSL2 연속성 ── */
    const buyAtr = new Array(n).fill(false);
    const sellAtr = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const a = atrS[i], s2 = sslDown2[i], bb = BBMC[i];
      if (a == null || s2 == null || bb == null) continue;
      const upperHalf = a * p.atrCrit + c[i].close;
      const lowerHalf = c[i].close - a * p.atrCrit;
      buyAtr[i] = lowerHalf < s2 && c[i].close > bb && c[i].close > s2;
      sellAtr[i] = upperHalf > s2 && c[i].close < bb && c[i].close < s2;
    }
    const ssl2Color = (i) => (buyAtr[i] ? bullAt(i) : sellAtr[i] ? bearAt(i) : withAlpha(NEUTRAL, 0));

    /* ── 표시 범위 게이팅 ── */
    const d = p.display;
    const showBase = d === "baseline" || d === "baseline_ssl" || d === "full";
    const showSsl1 = d === "ssl" || d === "baseline_ssl" || d === "full";
    const showSsl2 = d === "ssl" || d === "full";
    const showExit = d === "exit" || d === "full";

    const pt = (arr, colorFn) => toPoints(c, arr, { warmup, colorFn: (_, i) => colorFn(i) });

    /* ── 청산 화살표 (Pine codiff) ── */
    const exits = [];
    if (showExit) {
      for (let i = Math.max(1, warmup); i < n; i++) {
        const e = sslExit[i], ep = sslExit[i - 1];
        if (e == null || ep == null) continue;
        const up = c[i - 1].close <= ep && c[i].close > e;
        const dn = c[i - 1].close >= ep && c[i].close < e;
        if (up) exits.push({ time: c[i].time, position: "belowBar", shape: "arrowUp", color: bullAt(i), size: 1 });
        else if (dn) exits.push({ time: c[i].time, position: "aboveBar", shape: "arrowDown", color: bearAt(i), size: 1 });
      }
    }

    /* ── 베이스라인 위반 캔들 경고 (원본의 흰 다이아) ── */
    const warns = [];
    for (let i = warmup; i < n; i++) {
      const a = atrS[i], bb = BBMC[i];
      if (a == null || bb == null || upperBand[i] == null) continue;
      const inRange = upperBand[i] > bb && lowerBand[i] < bb;
      if (p.showSignals && Math.abs(c[i].close - c[i].open) > a && inRange) {
        warns.push({ i, price: c[i].high, position: "above", shape: "diamond", color: "#ffffff", size: 3.5 });
      }
    }

    /* ── 캔들 색칠 ── */
    const bars = [];
    if (p.colorBars) {
      for (let i = warmup; i < n; i++) bars.push({ time: c[i].time, color: baseColor(i) });
    }

    /* ── 리스크 표 (마지막 봉 상태) ── */
    const dash = [];
    if (p.showTable) {
      const i = n - 1;
      const a = atrS[i], bb = BBMC[i], pr = prank[i];
      if (a != null && bb != null && a > 0) {
        const dist = Math.abs(c[i].close - bb) / a;
        const distLabel = dist < 1 ? "가까움" : dist < 2 ? "벌어짐" : "멂";
        const riskLabel = pr == null ? "—" : pr > 75 ? "높음" : pr < 25 ? "낮음" : "보통";
        dash.push({ label: "리스크", value: riskLabel,
          color: riskLabel === "높음" ? p.bear : riskLabel === "낮음" ? p.bull : undefined });
        dash.push({ label: "진입 거리", value: distLabel,
          color: distLabel === "가까움" ? p.bull : distLabel === "벌어짐" ? "#eab308" : p.bear });
        dash.push({ label: "변동성 %", value: pr == null ? "—" : `${pr.toFixed(1)}%` });
        dash.push({ label: "ATR", value: a.toFixed(a < 1 ? 6 : 4) });
      }
    }

    /* ── 채널 채우기 (Pine fill(upper_channel, lower_channel)) ──
       원본은 추세색을 80% 투명으로 깐다. 시리즈로는 두 선 사이를 못 칠해서
       프리미티브로 그린다. */
    const fill = [];
    if (showBase && p.showChannel) {
      for (let i = warmup; i < n; i++) {
        if (upperk[i] == null || lowerk[i] == null) continue;
        const col = c[i].close > upperk[i] ? p.bull : c[i].close < lowerk[i] ? p.bear : NEUTRAL;
        fill.push({ i, upper: upperk[i], lower: lowerk[i], color: withAlpha(col, 80) });
      }
    }

    return {
      fill,
      baseline: showBase ? pt(BBMC, baseColor) : [],
      upper: showBase && p.showChannel ? pt(upperk, baseColor) : [],
      lower: showBase && p.showChannel ? pt(lowerk, baseColor) : [],
      ssl1: showSsl1 ? pt(sslDown, ssl1Color) : [],
      ssl2: showSsl2 ? pt(sslDown2, ssl2Color) : [],
      atrUp: p.showAtrBands ? toPoints(c, upperBand, { warmup }) : [],
      atrDn: p.showAtrBands ? toPoints(c, lowerBand, { warmup }) : [],
      exits, warns, bars, dash,
    };
  },
};

/* ═══════════════════════════════════════════
   ② SuperTrend AI (Clustering) — LuxAlgo
   ═══════════════════════════════════════════ */

const CLUSTER_OPTIONS = [
  { value: "2", label: "최상위" },
  { value: "1", label: "중간" },
  { value: "0", label: "최하위" },
];

// Pine array.percentile_linear_interpolation
const percentileLinear = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
};

export const SUPERTREND_AI = {
  id: "supertrend_ai",
  name: "SuperTrend AI (군집)",
  short: "STAI",
  category: "추세",
  target: "price",
  params: [
    { key: "length", label: "ATR 기간", type: "int", def: 10, min: 1, max: 200 },
    { key: "minMult", label: "배수 최소", type: "int", def: 1, min: 0, max: 50 },
    { key: "maxMult", label: "배수 최대", type: "int", def: 5, min: 1, max: 50 },
    { key: "step", label: "배수 간격", type: "float", def: 0.5, min: 0.1, max: 10, step: 0.1 },
    { key: "perfAlpha", label: "성과 기억", type: "float", def: 10, min: 2, max: 200, step: 1 },
    { key: "fromCluster", label: "사용할 군집", type: "select", def: "2", options: CLUSTER_OPTIONS },
    { key: "bullCss", label: "상승 추적손절", type: "color", def: "#008080" },
    { key: "bearCss", label: "하락 추적손절", type: "color", def: "#ff0000" },
    { key: "showAma", label: "적응형 이평 표시", type: "bool", def: true },
    { key: "showGradient", label: "캔들 그라데이션", type: "bool", def: true },
    { key: "showSignals", label: "전환 신호", type: "bool", def: true },
    { key: "showDash", label: "군집 표", type: "bool", def: true },
  ],
  outputs: [
    { key: "ts", type: "line", width: 2 },
    { key: "ama", type: "line" },
    { key: "signals", type: "markers" },
    { key: "bars", type: "barcolor" },
    { key: "dash", type: "dash" },
  ],
  legendColor: (p) => p.bullCss,
  label: (p) => `SuperTrend AI ${p.length}`,

  compute: (c, p) => {
    const n = c.length;
    const empty = { ts: [], ama: [], signals: [], bars: [], dash: [] };
    if (n === 0) return empty;

    const minMult = Math.min(p.minMult, p.maxMult);
    const maxMult = Math.max(p.minMult, p.maxMult);
    const stepV = Math.max(0.1, p.step);
    const atrS = atr(c, p.length, "RMA");

    const factors = [];
    for (let i = 0; i <= Math.trunc((maxMult - minMult) / stepV); i++) factors.push(minMult + i * stepV);
    if (!factors.length) return empty;

    const holder = factors.map((f) => ({ upper: null, lower: null, output: null, perf: 0, factor: f, trend: 0 }));
    const den = ema(c.map((x, i) => (i === 0 ? 0 : Math.abs(x.close - c[i - 1].close))), Math.round(p.perfAlpha));
    const from = Number(p.fromCluster);

    /* Pine 은 maxIter 1000 을 쓰지만, 빈 클러스터가 생기면 centroid 가 na 가 되고
       na == na 가 false 라 종료 조건이 영원히 안 걸린다 (전체 봉의 12~19%).
       상한을 5 로 낮춰도 TS·AMA 편차가 정확히 0 이면서 7~12배 빠른 것을 확인했다.
       빈 클러스터를 "제대로" 고치면(이전 centroid 유지) 결과가 3~12달러 어긋나
       TradingView 와 값이 달라지므로 하지 않는다. */
    const MAX_ITER = 5;

    const tsArr = new Array(n).fill(null);
    const amaArr = new Array(n).fill(null);
    const osArr = new Array(n).fill(0);
    const perfArr = new Array(n).fill(null);
    let upper = null, lower = null, os = 0, ama = null, targetFactor = null, perfIdx = null;
    let lastClusters = null, lastFactorClusters = null, lastCentroids = null;
    let firstBar = -1;

    for (let i = 0; i < n; i++) {
      const a = atrS[i];
      if (a == null) continue;
      if (firstBar < 0) firstBar = i;
      const hl2 = (c[i].high + c[i].low) / 2;
      const prevClose = i > 0 ? c[i - 1].close : c[i].close;

      for (const s of holder) {
        if (s.upper == null) { s.upper = hl2; s.lower = hl2; }
        const up = hl2 + a * s.factor;
        const dn = hl2 - a * s.factor;
        // 순서 중요 — trend 는 갱신 전 upper/lower 로 판정한다 (Pine 과 동일)
        s.trend = c[i].close > s.upper ? 1 : c[i].close < s.lower ? 0 : s.trend;
        s.upper = prevClose < s.upper ? Math.min(up, s.upper) : up;
        s.lower = prevClose > s.lower ? Math.max(dn, s.lower) : dn;
        const diff = s.output == null ? 0 : Math.sign(prevClose - s.output);
        s.perf += (2 / (p.perfAlpha + 1)) * ((i > 0 ? c[i].close - c[i - 1].close : 0) * diff - s.perf);
        s.output = s.trend === 1 ? s.lower : s.upper;
      }

      /* k-means (3 군집) */
      const data = holder.map((s) => s.perf);
      let centroids = [percentileLinear(data, 25), percentileLinear(data, 50), percentileLinear(data, 75)];
      let fClusters = null, pClusters = null;
      for (let it = 0; it < MAX_ITER; it++) {
        fClusters = [[], [], []];
        pClusters = [[], [], []];
        for (let k = 0; k < data.length; k++) {
          // Pine 의 array.min() 은 na 를 무시한다 → na centroid 에는 배정되지 않는다
          let bi = -1, bd = Infinity;
          for (let ci = 0; ci < 3; ci++) {
            if (!isFinite(centroids[ci])) continue;
            const dist = Math.abs(data[k] - centroids[ci]);
            if (dist < bd) { bd = dist; bi = ci; }
          }
          if (bi < 0) bi = 0;
          pClusters[bi].push(data[k]);
          fClusters[bi].push(factors[k]);
        }
        const next = pClusters.map((cl) => (cl.length ? cl.reduce((x, y) => x + y, 0) / cl.length : NaN));
        if (next[0] === centroids[0] && next[1] === centroids[1] && next[2] === centroids[2]) break;
        centroids = next;
      }
      lastClusters = pClusters;
      lastFactorClusters = fClusters;
      lastCentroids = centroids;

      const selF = fClusters[from];
      if (selF && selF.length) targetFactor = selF.reduce((x, y) => x + y, 0) / selF.length;
      const selP = pClusters[from];
      if (selP && selP.length && den[i]) {
        perfIdx = Math.max(nz(selP.reduce((x, y) => x + y, 0) / selP.length), 0) / den[i];
      }
      if (targetFactor == null) continue;

      if (upper == null) { upper = hl2; lower = hl2; }
      const up = hl2 + a * targetFactor;
      const dn = hl2 - a * targetFactor;
      upper = prevClose < upper ? Math.min(up, upper) : up;
      lower = prevClose > lower ? Math.max(dn, lower) : dn;
      os = c[i].close > upper ? 1 : c[i].close < lower ? 0 : os;
      const ts = os ? lower : upper;
      if (ama == null) ama = ts; else ama += (perfIdx ?? 0) * (ts - ama);

      tsArr[i] = ts;
      amaArr[i] = ama;
      osArr[i] = os;
      perfArr[i] = perfIdx;
    }

    const warmup = Math.min(n - 1, Math.max(p.length, Math.round(p.perfAlpha)) + 5);

    /* Pine: plot(ts, color = os != os[1] ? na : css) — 추세 전환 봉은 선을 끊는다 */
    const tsPoints = toPoints(c, tsArr, {
      warmup,
      gapFn: (i) => i > 0 && osArr[i] !== osArr[i - 1],
      colorFn: (_, i) => (osArr[i] ? p.bullCss : p.bearCss),
    });

    const amaPoints = p.showAma ? toPoints(c, amaArr, {
      warmup,
      gapFn: (i) => i > 0 && amaArr[i] != null && amaArr[i - 1] != null &&
        Math.sign(c[i].close - amaArr[i]) !== Math.sign(c[i - 1].close - amaArr[i - 1]),
      colorFn: (_, i) => withAlpha(c[i].close > amaArr[i] ? p.bullCss : p.bearCss, 50),
    }) : [];

    const bars = [];
    if (p.showGradient) {
      for (let i = warmup; i < n; i++) {
        if (tsArr[i] == null) continue;
        const css = osArr[i] ? p.bullCss : p.bearCss;
        // Pine: color.from_gradient(perf_idx, 0, 1, color.new(css,80), css)
        const t = Math.max(0, Math.min(1, perfArr[i] ?? 0));
        bars.push({ time: c[i].time, color: withAlpha(css, 80 - 80 * t) });
      }
    }

    const signals = [];
    if (p.showSignals) {
      for (let i = Math.max(warmup, 1); i < n; i++) {
        if (tsArr[i] == null || tsArr[i - 1] == null) continue;
        if (osArr[i] === osArr[i - 1]) continue;
        const txt = String(Math.trunc((perfArr[i] ?? 0) * 10));
        signals.push(osArr[i] > osArr[i - 1]
          ? { time: c[i].time, position: "atPriceBottom", price: tsArr[i], shape: "arrowUp", color: p.bullCss, text: txt, size: 1 }
          : { time: c[i].time, position: "atPriceTop", price: tsArr[i], shape: "arrowDown", color: p.bearCss, text: txt, size: 1 });
      }
    }

    const dash = [];
    if (p.showDash && lastClusters) {
      const names = ["최하위", "중간", "최상위"];
      for (let ci = 2; ci >= 0; ci--) {
        const size = lastClusters[ci].length;
        let disp = 0;
        if (size > 1 && isFinite(lastCentroids[ci])) {
          for (const v of lastClusters[ci]) disp += Math.abs(v - lastCentroids[ci]);
          disp /= size;
        }
        const fac = lastFactorClusters[ci];
        dash.push({
          label: names[ci],
          value: size === 0 ? "비어있음" : `${size}개 · 배수 ${fac[0]}~${fac[fac.length - 1]} · 분산 ${disp.toFixed(4)}`,
          color: ci === from ? p.bullCss : undefined,
        });
      }
    }

    return { ts: tsPoints, ama: amaPoints, signals, bars, dash };
  },
};

/* ═══════════════════════════════════════════
   ③ FluidTrades SMC Lite — 공급/수요 존 · BOS
   ═══════════════════════════════════════════ */

export const SMC_LITE = {
  id: "smc_lite",
  name: "SMC Lite (공급·수요)",
  short: "SMC",
  category: "추세",
  target: "price",
  params: [
    { key: "swing", label: "스윙 길이", type: "int", def: 10, min: 1, max: 50 },
    { key: "keep", label: "보관 개수", type: "int", def: 20, min: 5, max: 50 },
    { key: "boxWidth", label: "존 두께", type: "float", def: 2.5, min: 1, max: 10, step: 0.5 },
    { key: "supply", label: "공급 색", type: "color", def: "#ededed" },
    { key: "demand", label: "수요 색", type: "color", def: "#00ffff" },
    { key: "showPoi", label: "POI 선", type: "bool", def: true },
    { key: "showBos", label: "BOS 표시", type: "bool", def: true },
    { key: "showZigzag", label: "지그재그", type: "bool", def: false },
    { key: "zigzagColor", label: "지그재그 색", type: "color", def: "#8b8ba7" },
    { key: "showLabels", label: "HH/LL 라벨", type: "bool", def: false },
    { key: "labelColor", label: "라벨 색", type: "color", def: "#8b8ba7" },
  ],
  outputs: [
    { key: "zones", type: "boxes" },
    { key: "zigzag", type: "line" },
    { key: "labels", type: "markers" },
  ],
  legendColor: (p) => p.demand,
  label: (p) => `SMC ${p.swing}`,

  compute: (c, p) => {
    const n = c.length;
    const empty = { zones: [], zigzag: [], labels: [] };
    if (n < p.swing * 2 + 2) return empty;

    const atrArr = rma(trueRange(c), 50);
    const sw = p.swing;

    /* ta.pivothigh/pivotlow — 좌우 sw 봉보다 높으면(낮으면) 피벗.
       Pine 은 확정되는 시점(sw 봉 뒤)에 값을 내보내므로 여기서도 그 시점에 처리한다. */
    const pivotHigh = new Array(n).fill(null);
    const pivotLow = new Array(n).fill(null);
    for (let i = sw; i < n - sw; i++) {
      let ph = true, pl = true;
      for (let j = i - sw; j <= i + sw && (ph || pl); j++) {
        if (j === i) continue;
        if (c[j].high >= c[i].high) ph = false;
        if (c[j].low <= c[i].low) pl = false;
      }
      if (ph) pivotHigh[i + sw] = i;
      if (pl) pivotLow[i + sw] = i;
    }

    const supply = [], demand = [], bos = [], labels = [];
    const lastHigh = [], lastLow = [];

    // 새 존이 기존 존의 POI ±2ATR 안에 들어오면 겹치는 것으로 보고 버린다
    const overlaps = (poi, arr, a) => arr.some((b) => {
      const mid = (b.top + b.bottom) / 2;
      return poi >= mid - a * 2 && poi <= mid + a * 2;
    });

    for (let i = 0; i < n; i++) {
      const a = atrArr[i];
      if (a == null) continue;
      const buf = a * (p.boxWidth / 10);

      if (pivotHigh[i] != null) {
        const src = pivotHigh[i];
        const top = c[src].high, bottom = top - buf, poi = (top + bottom) / 2;
        if (p.showLabels) {
          const prev = lastHigh[lastHigh.length - 1];
          // 마커 색은 도형과 글자에 함께 쓰인다. size 0 으로 도형만 지운다.
          labels.push({ time: c[src].time, position: "aboveBar", shape: "circle", size: 0,
            color: p.labelColor, text: prev == null || top >= prev ? "HH" : "LH" });
        }
        lastHigh.push(top);
        if (!overlaps(poi, supply, a)) {
          supply.unshift({ left: src, top, bottom, poi });
          if (supply.length > p.keep) supply.pop();
        }
      }

      if (pivotLow[i] != null) {
        const src = pivotLow[i];
        const bottom = c[src].low, top = bottom + buf, poi = (top + bottom) / 2;
        if (p.showLabels) {
          const prev = lastLow[lastLow.length - 1];
          labels.push({ time: c[src].time, position: "belowBar", shape: "circle", size: 0,
            color: p.labelColor, text: prev == null || bottom >= prev ? "HL" : "LL" });
        }
        lastLow.push(bottom);
        if (!overlaps(poi, demand, a)) {
          demand.unshift({ left: src, top, bottom, poi });
          if (demand.length > p.keep) demand.pop();
        }
      }

      // 종가가 존을 뚫으면 존을 지우고 그 자리에 BOS 중앙선을 남긴다
      for (let k = supply.length - 1; k >= 0; k--) {
        if (c[i].close >= supply[k].top) {
          bos.push({ left: supply[k].left, right: i, price: supply[k].poi });
          supply.splice(k, 1);
        }
      }
      for (let k = demand.length - 1; k >= 0; k--) {
        if (c[i].close <= demand[k].bottom) {
          bos.push({ left: demand[k].left, right: i, price: demand[k].poi });
          demand.splice(k, 1);
        }
      }
    }

    /* 살아있는 존은 Pine 처럼 오른쪽으로 연장한다 */
    const rightEdge = n - 1 + 20;
    const zones = [];
    const push = (arr, label, color) => arr.forEach((b) => {
      zones.push({
        i1: b.left, i2: rightEdge, top: b.top, bottom: b.bottom,
        fill: withAlpha(color, 70), border: withAlpha("#ffffff", 75),
        label, labelColor: "#ffffff",
      });
      if (p.showPoi) {
        zones.push({
          i1: b.left, i2: rightEdge, top: b.poi, bottom: b.poi, dash: true,
          border: withAlpha("#ffffff", 60), label: "POI", labelAlign: "left", labelColor: "#ffffff",
        });
      }
    });
    push(supply, "SUPPLY", p.supply);
    push(demand, "DEMAND", p.demand);

    if (p.showBos) {
      bos.slice(-10).forEach((b) => zones.push({
        i1: b.left, i2: b.right, top: b.price, bottom: b.price,
        border: withAlpha("#ffffff", 40), label: "BOS", labelColor: "#ffffff",
      }));
    }

    /* 지그재그 — 피벗을 순서대로 이은 선 */
    const zigzag = [];
    if (p.showZigzag) {
      const pts = [];
      for (let i = 0; i < n; i++) {
        if (pivotHigh[i] != null) pts.push({ idx: pivotHigh[i], v: c[pivotHigh[i]].high });
        if (pivotLow[i] != null) pts.push({ idx: pivotLow[i], v: c[pivotLow[i]].low });
      }
      pts.sort((x, y) => x.idx - y.idx);
      let prev = -1;
      for (const q of pts) {
        if (q.idx === prev) continue;   // 같은 봉에 고·저 피벗이 겹치면 하나만
        prev = q.idx;
        zigzag.push({ time: c[q.idx].time, value: q.v, color: p.zigzagColor });
      }
    }

    return { zones, zigzag, labels };
  },
};

/* ═══════════════════════════════════════════
   ④ Volume Profile / Fixed Range — LonesomeTheBlue
   ═══════════════════════════════════════════ */

export const VOLUME_PROFILE = {
  id: "volume_profile",
  name: "볼륨 프로파일 (고정구간)",
  short: "VP",
  category: "거래량",
  target: "price",
  params: [
    { key: "bbars", label: "구간 봉 수", type: "int", def: 150, min: 10, max: 500 },
    { key: "cnum", label: "행 개수", type: "int", def: 24, min: 5, max: 100 },
    { key: "percent", label: "밸류에어리어 %", type: "float", def: 70, min: 10, max: 100, step: 5 },
    { key: "upColor", label: "상승 거래량", type: "color", def: "#2962ff" },
    { key: "downColor", label: "하락 거래량", type: "color", def: "#ff9800" },
    { key: "pocColor", label: "POC 색", type: "color", def: "#ff0000" },
    { key: "pocWidth", label: "POC 굵기", type: "int", def: 2, min: 1, max: 5 },
    { key: "showDash", label: "값 표시", type: "bool", def: true },
  ],
  outputs: [
    { key: "profile", type: "profile" },
    { key: "dash", type: "dash" },
  ],
  legendColor: (p) => p.pocColor,
  label: (p) => `볼륨 프로파일 ${p.bbars}`,

  compute: (c, p) => {
    const n = c.length;
    if (n === 0) return { profile: null, dash: [] };
    const bbars = Math.min(p.bbars, n);
    const i0 = n - bbars;
    const slice = c.slice(i0);

    let top = -Infinity, bot = Infinity;
    for (const b of slice) { if (b.high > top) top = b.high; if (b.low < bot) bot = b.low; }
    if (!(top > bot)) return { profile: null, dash: [] };

    const cnum = Math.max(5, Math.round(p.cnum));
    const step = (top - bot) / cnum;
    const levels = Array.from({ length: cnum + 1 }, (_, i) => bot + step * i);

    /* 두 구간이 겹치는 길이만큼 거래량을 나눠 담는다 (Pine get_vol).
       몸통·위꼬리·아래꼬리를 따로 배분해야 원본과 값이 맞는다. */
    const overlapVol = (a1, a2, b1, b2, height, vol) => {
      if (!(height > 0)) return 0;
      const ov = Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
      return ov > 0 ? (ov * vol) / height : 0;
    };

    const up = new Array(cnum).fill(0);
    const down = new Array(cnum).fill(0);
    for (const b of slice) {
      const bt = Math.max(b.close, b.open), bb = Math.min(b.close, b.open);
      const green = b.close >= b.open;
      const tw = b.high - bt, bw = bb - b.low, body = bt - bb;
      const denom = 2 * tw + 2 * bw + body;
      if (!(denom > 0)) continue;
      const bodyVol = (body * b.volume) / denom;
      const twVol = (2 * tw * b.volume) / denom;
      const bwVol = (2 * bw * b.volume) / denom;
      for (let x = 0; x < cnum; x++) {
        const l0 = levels[x], l1 = levels[x + 1];
        const wick = overlapVol(l0, l1, bt, b.high, tw, twVol) / 2
                   + overlapVol(l0, l1, bb, b.low, bw, bwVol) / 2;
        const bodyPart = overlapVol(l0, l1, bb, bt, body, bodyVol);
        up[x] += (green ? bodyPart : 0) + wick;
        down[x] += (green ? 0 : bodyPart) + wick;
      }
    }

    const total = up.map((v, i) => v + down[i]);
    let poc = 0;
    for (let i = 1; i < cnum; i++) if (total[i] > total[poc]) poc = i;

    // POC 에서 위아래로 넓혀가며 목표 비율을 채운다
    const target = total.reduce((a, b) => a + b, 0) * (p.percent / 100);
    let acc = total[poc], hi = poc, lo = poc;
    for (let x = 0; x < cnum; x++) {
      if (acc >= target) break;
      const uv = hi < cnum - 1 ? total[hi + 1] : 0;
      const lv = lo > 0 ? total[lo - 1] : 0;
      if (uv === 0 && lv === 0) break;
      if (uv >= lv) { acc += uv; hi++; } else { acc += lv; lo--; }
    }

    const maxVol = Math.max(...total);
    const pocPrice = (levels[poc] + levels[poc + 1]) / 2;
    const rows = total.map((_, x) => ({
      p0: levels[x], p1: levels[x + 1],
      up: up[x], down: down[x], inVA: x >= lo && x <= hi,
    }));

    const dash = [];
    if (p.showDash) {
      const d = pocPrice < 1 ? 6 : pocPrice < 100 ? 4 : 2;
      dash.push({ label: "POC", value: pocPrice.toFixed(d), color: p.pocColor });
      dash.push({ label: "VA 상단", value: levels[hi + 1].toFixed(d) });
      dash.push({ label: "VA 하단", value: levels[lo].toFixed(d) });
    }

    return {
      profile: {
        i0, i1: n - 1, rows, maxVol, poc: pocPrice,
        upColor: withAlpha(p.upColor, 75), downColor: withAlpha(p.downColor, 75),
        vaUpColor: withAlpha(p.upColor, 30), vaDownColor: withAlpha(p.downColor, 30),
        pocColor: p.pocColor, pocWidth: p.pocWidth,
      },
      dash,
    };
  },
};

export const PINE_INDICATORS = [SSL_HYBRID, SUPERTREND_AI, SMC_LITE, VOLUME_PROFILE];
