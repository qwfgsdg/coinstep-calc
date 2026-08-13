/* ═══════════════════════════════════════════
   보조지표 레지스트리

   지표 하나 = 객체 하나.
   목록 · 설정폼 · 차트 렌더가 전부 이 정의를 읽어서 자동으로 만들어지므로
   지표를 추가할 때 UI 코드는 건드리지 않는다.

   compute(candles, params) -> { [outputKey]: 출력 }

   출력 종류 (outputs[].type)
     line       [{ time, value, color? }]           color 는 봉마다 달라도 된다
     histogram  [{ time, value, color? }]
     markers    [{ time, position, shape, color, text?, size?, price? }]
     barcolor   [{ time, color }]                   캔들 자체를 칠한다
     dash       [{ label, value, color? }]          차트 위 상태 표 (마지막 봉 기준)

   아래 넷은 캔버스에 직접 그린다 (./primitives). x 좌표는 시각이 아니라 봉 인덱스다.
     band       [{ i, upper, lower, color }]        두 선 사이 채우기
     boxes      [{ i1, i2, top, bottom, ... }]      사각형 · 수평선 · 라벨
     profile    { i0, i1, rows, maxVol, poc, ... }  가로 히스토그램
     shapes     [{ i, price, shape, color, ... }]   다이아 등 임의 도형

   워밍업 구간(값이 없는 앞부분)은 아예 빼고 반환한다.
   수학 함수는 전부 ./ta 에 있다.
   ═══════════════════════════════════════════ */

import {
  sma, ema, stdev, wilder, emaSparse, trueRange, rsi,
  pickSrc, SRC_OPTIONS, toPoints,
} from "./ta";
import { PINE_INDICATORS } from "./indicators-pine";
import { PRIMITIVE_TYPES } from "./primitives";

// 예전 코드가 이 모듈에서 가져다 쓰던 것들 — 재수출로 호환 유지
export { sma, ema, rsi, stdev, wilder, emaSparse } from "./ta";

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
      vol: toPoints(candles, candles.map((c) => c.volume ?? 0), {
        colorFn: (c) => (c.close >= c.open ? p.up : p.down),
      }),
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
    compute: (c, p) => ({ atr: toPoints(c, wilder(trueRange(c), p.len, 1)) }),
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
        hist: toPoints(c, hist, { colorFn: (_, i) => (hist[i] >= 0 ? "#34d39966" : "#f8717166") }),
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

/* ── TradingView 이식 지표 ── */
REGISTRY.push(...PINE_INDICATORS);

export const byId = (id) => REGISTRY.find((r) => r.id === id);

export const defaults = (def) => {
  const o = {};
  (def.params || []).forEach((p) => { o[p.key] = p.def; });
  return o;
};

export const CATEGORIES = ["추세", "변동성", "모멘텀", "거래량"];

/* 출력 종류별 분류 — PositionChart 가 렌더 경로를 고를 때 쓴다 */
export const SERIES_TYPES = new Set(["line", "histogram"]);
export const seriesOutputs = (def) => (def.outputs || []).filter((o) => SERIES_TYPES.has(o.type));
export const outputsOfType = (def, type) => (def.outputs || []).filter((o) => o.type === type);
export const primitiveOutputs = (def) =>
  (def.outputs || []).filter((o) => PRIMITIVE_TYPES[o.type] !== undefined);
