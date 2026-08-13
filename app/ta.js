/* ═══════════════════════════════════════════
   기술적 분석 수학 모듈

   모든 함수는 "입력과 같은 길이, 워밍업 구간은 null" 규칙을 지킨다.
   지표 정의(indicators.js · indicators-pine.js)는 여기 있는 것만 조합해서 만든다.

   Pine Script 이식 주의사항 두 가지 — 실제 캔들로 검증하고 넣은 것이라 지우지 말 것:

   ① 재귀 필터(JMA·McGinley·MF·EDSMA)는 Pine 처럼 0 에서 시작하면 안 된다.
      TradingView 는 히스토리를 5000봉 넘게 로드해 워밍업이 화면 밖에 있지만
      우리는 500봉만 받는다. 0 시드로 하면 JMA(len=5) 가 1봉에서 473 → 시세 1884
      까지 치솟아 가격축이 통째로 뭉개진다. 첫 값으로 시드하면 30봉 뒤부터
      원본과 편차 1.7e-4 (부동소수점 오차) 로 일치한다.

   ② 각 MA 의 WARMUP 은 "이 봉 수 이전은 렌더하지 않는다" 는 뜻이다.
      재귀 필터는 수렴에 시간이 걸리므로 시드만으로는 부족하다.
   ═══════════════════════════════════════════ */

export const nz = (v, d = 0) => (v == null || !isFinite(v) ? d : v);

/* ── 소스 선택 ── */
export const pickSrc = (c, s) =>
  s === "open" ? c.open :
  s === "high" ? c.high :
  s === "low" ? c.low :
  s === "hl2" ? (c.high + c.low) / 2 :
  s === "hlc3" ? (c.high + c.low + c.close) / 3 :
  s === "ohlc4" ? (c.open + c.high + c.low + c.close) / 4 :
  c.close;

export const SRC_OPTIONS = [
  { value: "close", label: "종가" },
  { value: "open", label: "시가" },
  { value: "high", label: "고가" },
  { value: "low", label: "저가" },
  { value: "hl2", label: "고저 중간" },
  { value: "hlc3", label: "대표가" },
  { value: "ohlc4", label: "사가 평균" },
];

/* ── 앞쪽 null 을 건너뛰고 계산한 뒤 원래 위치로 되돌리는 래퍼 ──
   HMA 처럼 "MA 의 결과에 다시 MA 를 거는" 경우에 쓴다. */
export const sparse = (fn) => (arr, ...rest) => {
  const idx = [], vals = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] != null && isFinite(arr[i])) { idx.push(i); vals.push(arr[i]); }
  }
  const r = fn(vals, ...rest);
  const out = new Array(arr.length).fill(null);
  for (let i = 0; i < r.length; i++) if (r[i] != null) out[idx[i]] = r[i];
  return out;
};

/* ═══════ 기본 평균 ═══════ */

export function sma(v, len) {
  const out = new Array(v.length).fill(null);
  if (len <= 0) return out;
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= len) sum -= v[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

export function ema(v, len) {
  const out = new Array(v.length).fill(null);
  if (len <= 0 || v.length < len) return out;
  const k = 2 / (len + 1);
  let prev = 0;
  for (let j = 0; j < len; j++) prev += v[j];
  prev /= len;
  out[len - 1] = prev;
  for (let i = len; i < v.length; i++) {
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function wma(v, len) {
  const out = new Array(v.length).fill(null);
  if (len <= 0) return out;
  const denom = (len * (len + 1)) / 2;
  // 롤링: 가중합은 (이전 가중합 - 창 단순합 + len*새값) 으로 갱신된다
  let wsum = 0, ssum = 0;
  for (let i = 0; i < v.length; i++) {
    if (i < len) {
      ssum += v[i];
      wsum += v[i] * (i + 1);
      if (i === len - 1) out[i] = wsum / denom;
    } else {
      wsum = wsum - ssum + len * v[i];
      ssum = ssum + v[i] - v[i - len];
      out[i] = wsum / denom;
    }
  }
  return out;
}

export function rma(v, len) {
  const out = new Array(v.length).fill(null);
  if (len <= 0 || v.length < len) return out;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += v[i];
  let prev = sum / len;
  out[len - 1] = prev;
  for (let i = len; i < v.length; i++) {
    prev = (prev * (len - 1) + v[i]) / len;
    out[i] = prev;
  }
  return out;
}

// Wilder 평활 — 지정한 인덱스부터 시작 (ATR 처럼 첫 봉을 버려야 할 때)
export function wilder(v, len, from = 0) {
  const out = new Array(v.length).fill(null);
  if (v.length <= from + len - 1) return out;
  let sum = 0;
  for (let i = from; i < from + len; i++) sum += v[i];
  let prev = sum / len;
  out[from + len - 1] = prev;
  for (let i = from + len; i < v.length; i++) {
    prev = (prev * (len - 1) + v[i]) / len;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, len) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= len || len <= 0) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= len; loss /= len;
  out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (len - 1) + (d > 0 ? d : 0)) / len;
    loss = (loss * (len - 1) + (d < 0 ? -d : 0)) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export const emaSparse = sparse(ema);
export const wmaSparse = sparse(wma);
export const smaSparse = sparse(sma);

/* ═══════ 통계 · 범위 ═══════ */

// 모집단 표준편차 (Pine ta.stdev 와 동일)
export function stdev(v, len) {
  const out = new Array(v.length).fill(null);
  if (len <= 1) return out;
  let s = 0, s2 = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i]; s2 += v[i] * v[i];
    if (i >= len) { s -= v[i - len]; s2 -= v[i - len] * v[i - len]; }
    if (i >= len - 1) {
      const m = s / len;
      out[i] = Math.sqrt(Math.max(0, s2 / len - m * m));
    }
  }
  return out;
}

export function highest(v, len) {
  const out = new Array(v.length).fill(null);
  if (len <= 0) return out;
  for (let i = len - 1; i < v.length; i++) {
    let m = -Infinity;
    for (let j = i - len + 1; j <= i; j++) if (v[j] > m) m = v[j];
    out[i] = m;
  }
  return out;
}

export function lowest(v, len) {
  const out = new Array(v.length).fill(null);
  if (len <= 0) return out;
  for (let i = len - 1; i < v.length; i++) {
    let m = Infinity;
    for (let j = i - len + 1; j <= i; j++) if (v[j] < m) m = v[j];
    out[i] = m;
  }
  return out;
}

// Pine ta.percentrank — 과거 len 봉 중 현재값 이하인 비율(%)
export function percentRank(v, len) {
  const out = new Array(v.length).fill(null);
  for (let i = len; i < v.length; i++) {
    if (v[i] == null) continue;
    let cnt = 0, tot = 0;
    for (let j = i - len; j < i; j++) {
      if (v[j] == null) continue;
      tot++;
      if (v[j] <= v[i]) cnt++;
    }
    if (tot) out[i] = (cnt / tot) * 100;
  }
  return out;
}

// Pine ta.linreg(src, len, 0) — 회귀선의 현재 봉 값
export function linreg(v, len) {
  const out = new Array(v.length).fill(null);
  if (len <= 1) return out;
  const sumX = ((len - 1) * len) / 2;
  const sumX2 = ((len - 1) * len * (2 * len - 1)) / 6;
  const denom = len * sumX2 - sumX * sumX;
  if (denom === 0) return out;
  for (let i = len - 1; i < v.length; i++) {
    let sumY = 0, sumXY = 0;
    for (let x = 0; x < len; x++) {
      const y = v[i - len + 1 + x];
      sumY += y; sumXY += x * y;
    }
    const slope = (len * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / len;
    out[i] = intercept + slope * (len - 1);
  }
  return out;
}

export function trueRange(c) {
  return c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(
    x.high - x.low,
    Math.abs(x.high - c[i - 1].close),
    Math.abs(x.low - c[i - 1].close)
  )));
}

export function atr(c, len, smoothing = "RMA") {
  const tr = trueRange(c);
  return smoothing === "SMA" ? sma(tr, len)
    : smoothing === "EMA" ? ema(tr, len)
    : smoothing === "WMA" ? wma(tr, len)
    : rma(tr, len);
}

/* ═══════ 이동평균 라이브러리 (SSL Hybrid 원본 14종) ═══════
   각 항목: { calc, warmup } — warmup 은 렌더에서 잘라낼 앞 봉 수 */

const jma = (v, len, phase = 3, power = 1) => {
  const phaseRatio = phase < -100 ? 0.5 : phase > 100 ? 2.5 : phase / 100 + 1.5;
  const beta = (0.45 * (len - 1)) / (0.45 * (len - 1) + 2);
  const alpha = Math.pow(beta, power);
  const out = new Array(v.length).fill(null);
  if (!v.length) return out;
  // ① 0 시드 금지 — 파일 상단 주석 참고
  let e0 = v[0], e1 = 0, e2 = 0, j = v[0];
  const om = Math.pow(1 - alpha, 2), a2 = Math.pow(alpha, 2);
  for (let i = 0; i < v.length; i++) {
    e0 = (1 - alpha) * v[i] + alpha * e0;
    e1 = (v[i] - e0) * (1 - beta) + beta * e1;
    e2 = (e0 + phaseRatio * e1 - j) * om + a2 * e2;
    j = e2 + j;
    out[i] = j;
  }
  return out;
};

const mcginley = (v, len) => {
  const out = new Array(v.length).fill(null);
  const seed = ema(v, len);
  let mg = null;
  for (let i = 0; i < v.length; i++) {
    if (mg == null) {
      if (seed[i] == null) continue;
      mg = seed[i];
    } else {
      const ratio = v[i] / mg;
      // ratio^4 이 0 이면 0 나눗셈. Pine 은 na 로 흘리지만 여기선 직전 값을 유지한다.
      const d = len * Math.pow(ratio, 4);
      if (isFinite(d) && d !== 0) mg = mg + (v[i] - mg) / d;
    }
    out[i] = mg;
  }
  return out;
};

// Modular Filter — Pine 원본의 b/c/os 상태를 그대로 재현
const modularFilter = (v, len, beta = 0.8, feedback = false, z = 0.5) => {
  const out = new Array(v.length).fill(null);
  const alpha = 2 / (len + 1);
  let b = null, c = null, os = 0, ts = null;
  for (let i = 0; i < v.length; i++) {
    const a = feedback && ts != null ? z * v[i] + (1 - z) * ts : v[i];
    const bPrev = b == null ? a : b;
    const cPrev = c == null ? a : c;
    const bCand = alpha * a + (1 - alpha) * bPrev;
    const cCand = alpha * a + (1 - alpha) * cPrev;
    b = a > bCand ? a : bCand;
    c = a < cCand ? a : cCand;
    os = a === b ? 1 : a === c ? 0 : os;
    const upper = beta * b + (1 - beta) * c;
    const lower = beta * c + (1 - beta) * b;
    ts = os * upper + (1 - os) * lower;
    out[i] = ts;
  }
  return out;
};

const ssf2Pole = (v, length) => {
  const arg = (Math.SQRT2 * Math.PI) / length;
  const a1 = Math.exp(-arg);
  const c2 = 2 * a1 * Math.cos(arg);
  const c3 = -Math.pow(a1, 2);
  const c1 = 1 - c2 - c3;
  const out = new Array(v.length).fill(0);
  for (let i = 0; i < v.length; i++) {
    out[i] = c1 * v[i] + c2 * (i >= 1 ? out[i - 1] : 0) + c3 * (i >= 2 ? out[i - 2] : 0);
  }
  return out;
};

const ssf3Pole = (v, length) => {
  const arg = Math.PI / length;
  const a1 = Math.exp(-arg);
  const b1 = 2 * a1 * Math.cos(1.738 * arg);
  const c1 = Math.pow(a1, 2);
  const coef2 = b1 + c1;
  const coef3 = -(c1 + b1 * c1);
  const coef4 = Math.pow(c1, 2);
  const coef1 = 1 - coef2 - coef3 - coef4;
  const out = new Array(v.length).fill(0);
  for (let i = 0; i < v.length; i++) {
    out[i] = coef1 * v[i]
      + coef2 * (i >= 1 ? out[i - 1] : 0)
      + coef3 * (i >= 2 ? out[i - 2] : 0)
      + coef4 * (i >= 3 ? out[i - 3] : 0);
  }
  return out;
};

const edsma = (v, len, ssfLength = 20, ssfPoles = 2) => {
  const zeros = v.map((x, i) => x - (i >= 2 ? v[i - 2] : v[0]));
  const avgZeros = zeros.map((x, i) => (x + (i >= 1 ? zeros[i - 1] : x)) / 2);
  const ssf = ssfPoles === 3 ? ssf3Pole(avgZeros, ssfLength) : ssf2Pole(avgZeros, ssfLength);
  const sd = stdev(ssf, len);
  const out = new Array(v.length).fill(null);
  let prev = v[0];
  for (let i = 0; i < v.length; i++) {
    const scaled = sd[i] != null && sd[i] !== 0 ? ssf[i] / sd[i] : 0;
    const alpha = Math.min(1, (5 * Math.abs(scaled)) / len);
    prev = alpha * v[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
};

/* MA 디스패처.
   Kijun v2 만 src 를 무시하고 캔들의 high/low 를 직접 쓴다 (Pine 원본과 동일한 성질). */
export const MA_TYPES = [
  "SMA", "EMA", "DEMA", "TEMA", "LSMA", "WMA", "MF",
  "VAMA", "TMA", "HMA", "JMA", "Kijun v2", "EDSMA", "McGinley",
];

export const MA_OPTIONS = MA_TYPES.map((t) => ({ value: t, label: t }));

// 렌더에서 잘라낼 앞 봉 수. 재귀 필터는 길이와 무관하게 최소치를 둔다.
export function maWarmup(type, len) {
  switch (type) {
    case "JMA": return Math.max(30, len * 2);
    case "McGinley": return Math.max(30, len * 2);
    case "MF": return Math.max(30, len * 2);
    case "EDSMA": return Math.max(50, len * 2);
    case "HMA": return len + Math.round(Math.sqrt(len));
    case "TEMA": return len * 3;
    case "DEMA": return len * 2;
    case "VAMA": return len + 10;
    case "TMA": return len + 2;
    default: return len;
  }
}

export function ma(type, candles, src, len, opt = {}) {
  const L = Math.max(1, Math.round(len));
  switch (type) {
    case "SMA": return sma(src, L);
    case "EMA": return ema(src, L);
    case "WMA": return wma(src, L);
    case "LSMA": return linreg(src, L);
    case "DEMA": {
      const e = ema(src, L);
      const e2 = emaSparse(e, L);
      return e.map((x, i) => (x == null || e2[i] == null ? null : 2 * x - e2[i]));
    }
    case "TEMA": {
      const e1 = ema(src, L);
      const e2 = emaSparse(e1, L);
      const e3 = emaSparse(e2, L);
      return e1.map((x, i) =>
        x == null || e2[i] == null || e3[i] == null ? null : 3 * (x - e2[i]) + e3[i]);
    }
    case "TMA": {
      const inner = sma(src, Math.ceil(L / 2));
      return smaSparse(inner, Math.floor(L / 2) + 1);
    }
    case "HMA": {
      const half = wma(src, Math.max(1, Math.trunc(L / 2)));
      const full = wma(src, L);
      const raw = src.map((_, i) =>
        half[i] == null || full[i] == null ? null : 2 * half[i] - full[i]);
      return wmaSparse(raw, Math.max(1, Math.round(Math.sqrt(L))));
    }
    case "VAMA": {
      const lb = opt.volatilityLookback ?? 10;
      const mid = ema(src, L);
      const dev = src.map((x, i) => (mid[i] == null ? null : x - mid[i]));
      const up = sparse(highest)(dev, lb);
      const dn = sparse(lowest)(dev, lb);
      return mid.map((x, i) =>
        x == null || up[i] == null || dn[i] == null ? null : x + (up[i] + dn[i]) / 2);
    }
    case "Kijun v2": {
      const kidiv = Math.max(1, opt.kidiv ?? 1);
      const hi = candles.map((c) => c.high);
      const lo = candles.map((c) => c.low);
      const kijun = highest(hi, L).map((h, i) => {
        const l = lowest(lo, L)[i];
        return h == null || l == null ? null : (h + l) / 2;
      });
      const cl = Math.max(1, Math.round(L / kidiv));
      const cHi = highest(hi, cl), cLo = lowest(lo, cl);
      return kijun.map((k, i) =>
        k == null || cHi[i] == null || cLo[i] == null ? null : (k + (cHi[i] + cLo[i]) / 2) / 2);
    }
    case "JMA": return jma(src, L, opt.jurikPhase ?? 3, opt.jurikPower ?? 1);
    case "McGinley": return mcginley(src, L);
    case "MF": return modularFilter(src, L, opt.beta ?? 0.8, opt.feedback ?? false, opt.z ?? 0.5);
    case "EDSMA": return edsma(src, L, opt.ssfLength ?? 20, opt.ssfPoles ?? 2);
    default: return sma(src, L);
  }
}

/* ═══════ 색 유틸 ═══════ */

const hex2rgb = (h) => {
  let s = String(h).replace("#", "").trim();
  if (s.length === 3) s = s.split("").map((x) => x + x).join("");
  if (s.length === 8) s = s.slice(0, 6);   // 이미 알파가 붙어 있으면 버린다
  const n = parseInt(s, 16);
  return Number.isNaN(n) ? [136, 136, 136] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Pine color.new(c, transparency) — transparency 는 0(불투명)~100(투명)
export function withAlpha(hex, transparency = 0) {
  const [r, g, b] = hex2rgb(hex);
  const a = Math.max(0, Math.min(1, 1 - transparency / 100));
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

// Pine color.from_gradient(v, lo, hi, cLo, cHi)
export function gradient(v, lo, hi, cLo, cHi) {
  const t = hi === lo ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  const [r1, g1, b1] = hex2rgb(cLo), [r2, g2, b2] = hex2rgb(cHi);
  const m = (a, b) => Math.round(a + (b - a) * t);
  return `rgb(${m(r1, r2)},${m(g1, g2)},${m(b1, b2)})`;
}

/* ═══════ 출력 변환 ═══════ */

/* 배열 → lightweight-charts 포인트.
   opt.colorFn  봉별 색 (LineData.color — 시리즈를 쪼갤 필요가 없다)
   opt.gapFn    true 를 반환한 봉은 whitespace 로 넣어 선을 끊는다 (Pine 의 color=na)
   opt.warmup   이 인덱스 미만은 통째로 버린다 (재귀 필터 발산 방지) */
export function toPoints(candles, arr, opt = {}) {
  const { colorFn, gapFn, warmup = 0 } = opt;
  const out = [];
  for (let i = warmup; i < arr.length; i++) {
    const t = candles[i].time;
    if (gapFn && gapFn(i)) { out.push({ time: t }); continue; }
    const v = arr[i];
    if (v == null || !isFinite(v)) continue;
    const p = { time: t, value: v };
    if (colorFn) {
      const c = colorFn(candles[i], i);
      if (c) p.color = c;
    }
    out.push(p);
  }
  return out;
}
