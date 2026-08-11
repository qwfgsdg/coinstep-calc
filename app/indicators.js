/* ═══════════════════════════════════════════
   보조지표 레지스트리

   지표 하나 = 객체 하나.
   목록 · 설정폼 · 차트 렌더가 전부 이 정의를 읽어서 자동으로 만들어지므로
   지표를 추가할 때 UI 코드는 건드리지 않는다.

   compute(candles, params) -> { [outputKey]: [{ time, value, color? }] }
   워밍업 구간(값이 없는 앞부분)은 아예 빼고 반환한다.
   ═══════════════════════════════════════════ */

const pickSrc = (c, s) =>
  s === "open" ? c.open :
  s === "high" ? c.high :
  s === "low" ? c.low :
  s === "hl2" ? (c.high + c.low) / 2 :
  s === "hlc3" ? (c.high + c.low + c.close) / 3 :
  c.close;

/* ── 계산 헬퍼 (입력과 같은 길이, 워밍업은 null) ── */

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

// 롤링 표준편차 (평균은 sma 와 같은 창)
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

// Wilder 평활 (ATR 용)
export function wilder(v, len, from) {
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

// null 이 섞인 배열에 EMA 를 걸어 원래 위치로 되돌린다 (MACD 시그널용)
export function emaSparse(arr, len) {
  const out = new Array(arr.length).fill(null);
  const idx = [], vals = [];
  arr.forEach((v, i) => { if (v != null) { idx.push(i); vals.push(v); } });
  const e = ema(vals, len);
  e.forEach((v, i) => { if (v != null) out[idx[i]] = v; });
  return out;
}

// 배열 -> lightweight-charts 포인트 (null 구간 제거)
const toPoints = (candles, arr, colorFn) => {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null || !isFinite(arr[i])) continue;
    const p = { time: candles[i].time, value: arr[i] };
    if (colorFn) p.color = colorFn(candles[i], i);
    out.push(p);
  }
  return out;
};

const SRC_OPTIONS = [
  { value: "close", label: "종가" },
  { value: "open", label: "시가" },
  { value: "high", label: "고가" },
  { value: "low", label: "저가" },
  { value: "hl2", label: "고저 중간" },
  { value: "hlc3", label: "대표가" },
];

/* ── 레지스트리 ── */

export const REGISTRY = [
  {
    id: "ma",
    name: "이동평균",
    short: "MA",
    category: "추세",
    target: "price",
    params: [
      { key: "len", label: "기간", type: "int", def: 20, min: 1, max: 500 },
      { key: "src", label: "소스", type: "select", def: "close", options: SRC_OPTIONS },
      { key: "color", label: "색", type: "color", def: "#f59e0b" },
      { key: "width", label: "굵기", type: "int", def: 1, min: 1, max: 4 },
    ],
    outputs: [{ key: "ma", type: "line" }],
    label: (p) => `MA ${p.len}`,
    compute: (candles, p) => ({
      ma: toPoints(candles, sma(candles.map((c) => pickSrc(c, p.src)), p.len)),
    }),
  },

  {
    id: "volume",
    name: "거래량",
    short: "VOL",
    category: "거래량",
    target: "pane",
    params: [
      { key: "up", label: "상승 색", type: "color", def: "#34d39966" },
      { key: "down", label: "하락 색", type: "color", def: "#f8717166" },
    ],
    outputs: [{ key: "vol", type: "histogram" }],
    label: () => "거래량",
    compute: (candles, p) => ({
      vol: toPoints(
        candles,
        candles.map((c) => c.volume ?? 0),
        (c) => (c.close >= c.open ? p.up : p.down)
      ),
    }),
  },

  {
    id: "rsi",
    name: "RSI",
    short: "RSI",
    category: "모멘텀",
    target: "pane",
    params: [
      { key: "len", label: "기간", type: "int", def: 14, min: 2, max: 200 },
      { key: "color", label: "색", type: "color", def: "#a78bfa" },
      { key: "width", label: "굵기", type: "int", def: 1, min: 1, max: 4 },
    ],
    outputs: [{ key: "rsi", type: "line" }],
    guides: [
      { value: 70, color: "#f8717155" },
      { value: 30, color: "#34d39955" },
    ],
    label: (p) => `RSI ${p.len}`,
    compute: (candles, p) => ({
      rsi: toPoints(candles, rsi(candles.map((c) => c.close), p.len)),
    }),
  },
];

/* ── 나머지 5종 ── */

REGISTRY.push(
  {
    id: "ema",
    name: "지수이동평균",
    short: "EMA",
    category: "추세",
    target: "price",
    params: [
      { key: "len", label: "기간", type: "int", def: 20, min: 1, max: 500 },
      { key: "src", label: "소스", type: "select", def: "close", options: SRC_OPTIONS },
      { key: "color", label: "색", type: "color", def: "#22d3ee" },
      { key: "width", label: "굵기", type: "int", def: 1, min: 1, max: 4 },
    ],
    outputs: [{ key: "ema", type: "line" }],
    label: (p) => `EMA ${p.len}`,
    compute: (c, p) => ({ ema: toPoints(c, ema(c.map((x) => pickSrc(x, p.src)), p.len)) }),
  },

  {
    id: "bb",
    name: "볼린저밴드",
    short: "BB",
    category: "변동성",
    target: "price",
    params: [
      { key: "len", label: "기간", type: "int", def: 20, min: 2, max: 500 },
      { key: "mult", label: "표준편차 배수", type: "int", def: 2, min: 1, max: 5 },
      { key: "band", label: "밴드 색", type: "color", def: "#8b8ba7" },
      { key: "mid", label: "중심선 색", type: "color", def: "#8b8ba766" },
    ],
    outputs: [
      { key: "upper", type: "line", colorParam: "band" },
      { key: "mid", type: "line", colorParam: "mid" },
      { key: "lower", type: "line", colorParam: "band" },
    ],
    label: (p) => `볼린저 ${p.len},${p.mult}`,
    compute: (c, p) => {
      const v = c.map((x) => x.close);
      const m = sma(v, p.len), s = stdev(v, p.len);
      const up = m.map((x, i) => (x == null || s[i] == null ? null : x + p.mult * s[i]));
      const lo = m.map((x, i) => (x == null || s[i] == null ? null : x - p.mult * s[i]));
      return { upper: toPoints(c, up), mid: toPoints(c, m), lower: toPoints(c, lo) };
    },
  },

  {
    id: "atr",
    name: "ATR (변동폭)",
    short: "ATR",
    category: "변동성",
    target: "pane",
    params: [
      { key: "len", label: "기간", type: "int", def: 14, min: 2, max: 200 },
      { key: "color", label: "색", type: "color", def: "#f59e0b" },
      { key: "width", label: "굵기", type: "int", def: 1, min: 1, max: 4 },
    ],
    outputs: [{ key: "atr", type: "line" }],
    label: (p) => `ATR ${p.len}`,
    compute: (c, p) => {
      const tr = c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(
        x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)
      )));
      return { atr: toPoints(c, wilder(tr, p.len, 1)) };
    },
  },

  {
    id: "macd",
    name: "MACD",
    short: "MACD",
    category: "모멘텀",
    target: "pane",
    params: [
      { key: "fast", label: "단기", type: "int", def: 12, min: 1, max: 200 },
      { key: "slow", label: "장기", type: "int", def: 26, min: 2, max: 400 },
      { key: "sig", label: "시그널", type: "int", def: 9, min: 1, max: 100 },
      { key: "macdColor", label: "MACD 색", type: "color", def: "#0ea5e9" },
      { key: "sigColor", label: "시그널 색", type: "color", def: "#f59e0b" },
    ],
    outputs: [
      { key: "hist", type: "histogram" },
      { key: "macd", type: "line", colorParam: "macdColor" },
      { key: "signal", type: "line", colorParam: "sigColor" },
    ],
    guides: [{ value: 0, color: "#8b8ba755" }],
    label: (p) => `MACD ${p.fast},${p.slow},${p.sig}`,
    compute: (c, p) => {
      const v = c.map((x) => x.close);
      const f = ema(v, p.fast), s = ema(v, p.slow);
      const m = f.map((x, i) => (x == null || s[i] == null ? null : x - s[i]));
      const sig = emaSparse(m, p.sig);
      const hist = m.map((x, i) => (x == null || sig[i] == null ? null : x - sig[i]));
      return {
        macd: toPoints(c, m),
        signal: toPoints(c, sig),
        hist: toPoints(c, hist, (_, i) => (hist[i] >= 0 ? "#34d39966" : "#f8717166")),
      };
    },
  },

  {
    id: "stoch",
    name: "스토캐스틱",
    short: "STOCH",
    category: "모멘텀",
    target: "pane",
    params: [
      { key: "len", label: "기간", type: "int", def: 14, min: 2, max: 200 },
      { key: "smooth", label: "%D 평활", type: "int", def: 3, min: 1, max: 50 },
      { key: "kColor", label: "%K 색", type: "color", def: "#0ea5e9" },
      { key: "dColor", label: "%D 색", type: "color", def: "#f59e0b" },
    ],
    outputs: [
      { key: "k", type: "line", colorParam: "kColor" },
      { key: "d", type: "line", colorParam: "dColor" },
    ],
    guides: [
      { value: 80, color: "#f8717155" },
      { value: 20, color: "#34d39955" },
    ],
    label: (p) => `스토캐스틱 ${p.len},${p.smooth}`,
    compute: (c, p) => {
      const k = new Array(c.length).fill(null);
      for (let i = p.len - 1; i < c.length; i++) {
        let hi = -Infinity, lo = Infinity;
        for (let j = i - p.len + 1; j <= i; j++) {
          if (c[j].high > hi) hi = c[j].high;
          if (c[j].low < lo) lo = c[j].low;
        }
        k[i] = hi === lo ? 50 : ((c[i].close - lo) / (hi - lo)) * 100;
      }
      const kv = [], kidx = [];
      k.forEach((x, i) => { if (x != null) { kv.push(x); kidx.push(i); } });
      const dRaw = sma(kv, p.smooth);
      const d = new Array(c.length).fill(null);
      dRaw.forEach((x, i) => { if (x != null) d[kidx[i]] = x; });
      return { k: toPoints(c, k), d: toPoints(c, d) };
    },
  }
);

export const byId = (id) => REGISTRY.find((r) => r.id === id);

export const defaults = (def) => {
  const o = {};
  (def.params || []).forEach((p) => { o[p.key] = p.def; });
  return o;
};

export const CATEGORIES = ["추세", "변동성", "모멘텀", "거래량"];
