/* ═══════════════════════════════════════════
   그리기 도구 레지스트리

   지표 레지스트리(./indicators)와 같은 규약이다. 도구 하나 = 객체 하나이고
   툴바·스타일 폼·렌더가 전부 이 정의를 읽으므로 도구를 늘릴 때 UI 는 안 건드린다.

   핵심: 도구마다 draw 함수를 따로 쓰지 않는다.
   19종이 기하(KINDS) 5가지를 공유하고 나머지는 전부 플래그다.
     line     라인 9종      2점 선 / 1점 선 + 연장·라벨 플래그
     channel  채널 4종      두 번째 선을 어디서 얻느냐만 다르다
     fib      피보나치 2종  되돌림 / 확장
     position 롱·숏 포지션  방향 플래그
     box      사각형 · 측정자

   ── 인터페이스
     shape(env)             → { segs, poly, extra }  그릴 것 + 잡을 것
     draw(ctx, env, shape)
     hit(x, y, env, shape)  → { d, priority } | null   면 0 · 선 1
     box(shape, pts, pad)   → 히트 선검사용 바운딩 박스

   env = { pts, def, style, map, candles, logicals, w, h, info }
     pts       앵커의 화면 좌표
     map       { x(봉인덱스) y(가격) price(y) } — 회귀 추세처럼 데이터에서
               값을 만들어 다시 화면으로 올려야 하는 도구가 쓴다
     logicals  앵커의 봉 인덱스 (소수 가능)

   좌표는 전부 화면 픽셀이다. time↔인덱스 변환은 호출부(drawing-layer)가 끝낸다.
   ═══════════════════════════════════════════ */

import {
  clipLine, distToSegment, angleDeg, bboxOf, inPoly,
  parallelThrough, flatThrough, linregFit, fibLevels,
} from "./drawing-geom.mjs";

/* 클리핑 여유. 캔버스 바로 밖까지만 그리면 되고, 좁을수록 바운딩 박스가
   조여져 hitTest 선검사가 잘 걸러낸다. */
const CLIP_PAD = 8;
const ANCHOR_R = 4;

const UP = "#34d399";
const DOWN = "#f87171";

/* ── 파라미터 묶음 ───────────────────────────
   스타일 바가 이 정의를 그대로 읽어 입력을 만든다. */
export const LINE_PARAMS = [
  { key: "color", label: "색", type: "color", def: "#0ea5e9" },
  { key: "width", label: "굵기", type: "int", def: 2, min: 1, max: 5 },
  { key: "dash", label: "점선", type: "bool", def: false },
];
const FILLED = [...LINE_PARAMS, { key: "fill", label: "채우기", type: "bool", def: true }];
const REG_PARAMS = [
  ...LINE_PARAMS,
  { key: "mult", label: "편차", type: "float", def: 2, min: 0.5, max: 5, step: 0.5 },
  { key: "showR", label: "R", type: "bool", def: true },
];
const FIB_PARAMS = [
  ...LINE_PARAMS,
  { key: "fill", label: "채우기", type: "bool", def: true },
  { key: "extendRight", label: "우연장", type: "bool", def: true },
];

export const defaultStyle = (def) => {
  const s = {};
  (def?.params || LINE_PARAMS).forEach((p) => { s[p.key] = p.def; });
  return s;
};

/* ── 캔버스 도우미 ─────────────────────────── */

function stroke(ctx, s, style, boost = 0, over = {}) {
  if (!s) return;
  ctx.beginPath();
  ctx.strokeStyle = over.color || style.color;
  ctx.lineWidth = (over.width ?? style.width ?? 2) + boost;
  ctx.setLineDash(over.dash ?? style.dash ? [5, 4] : []);
  ctx.moveTo(s.x1, s.y1);
  ctx.lineTo(s.x2, s.y2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function fillPoly(ctx, poly, color) {
  if (!poly || poly.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function handles(ctx, pts, color) {
  for (const p of pts) {
    if (!p || p.x == null || p.y == null) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ANCHOR_R, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/* 값 꼬리표. 배경을 깔지 않으면 캔들 위에서 글씨가 안 읽힌다. */
function tag(ctx, x, y, lines, color, align = "left") {
  ctx.font = "10px 'DM Sans', sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 10;
  const h = lines.length * 13 + 6;
  const bx = align === "right" ? x - w - 8 : x + 8;
  const by = y - h / 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, w, h, 3);
  else ctx.rect(bx, by, w, h);
  ctx.fillStyle = "#0b0b14e6";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = color;
  lines.forEach((t, i) => ctx.fillText(t, bx + 5, by + 10 + i * 13));
}

/* 작은 글씨 — 피보나치 레벨처럼 배경 없이 얹는다 */
function label(ctx, x, y, text, color, align = "left") {
  ctx.font = "9px 'DM Sans', sans-serif";
  ctx.textBaseline = "bottom";
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textAlign = "left";
}

const alpha = (hex, a) => {
  const h = String(hex).slice(0, 7);
  const v = Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");
  return h + v;
};

const dec = (v) => {
  const a = Math.abs(v);
  return a >= 1000 ? 2 : a >= 1 ? 3 : 6;
};
const fmtDelta = (v) => (v >= 0 ? "+" : "") + v.toFixed(dec(v)).replace(/\.?0+$/, "");
const fmtPrice = (v) => v.toFixed(dec(v)).replace(/\.?0+$/, "");
const pct = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

/* 앵커 좌표가 다 있는지 */
const ready = (pts, n) =>
  pts.length >= n && pts.slice(0, n).every((p) => p && p.x != null && p.y != null);

/* ── 기하 1: 선 ─────────────────────────────
   라인 9종이 전부 여기를 지난다. 먼저 화면 경계로 자르고 나면 종류에 상관없이
   그냥 선분이므로, 그리기도 히트도 한 가지 코드로 끝난다. */

const LINE = {
  shape({ pts, def, w, h }) {
    if (def.points === 1) {
      const p = pts[0];
      if (!p || p.x == null || p.y == null) return { segs: [] };
      const segs = [];
      if (def.horizontal) segs.push(clipLine(p.x, p.y, p.x + 1, p.y, def.extendLeft, def.extendRight, w, h, CLIP_PAD));
      if (def.vertical) segs.push(clipLine(p.x, p.y, p.x, p.y + 1, true, true, w, h, CLIP_PAD));
      return { segs };
    }
    if (!ready(pts, 2)) return { segs: [] };
    const [a, b] = pts;
    return { segs: [clipLine(a.x, a.y, b.x, b.y, def.extendLeft, def.extendRight, w, h, CLIP_PAD)] };
  },

  draw(ctx, { pts, def, style, selected, hovered, info }, { segs }) {
    const boost = selected || hovered ? 1 : 0;
    segs.forEach((s) => stroke(ctx, s, style, boost));

    if (def.label === "angle" && ready(pts, 2)) {
      const [a, b] = pts;
      const deg = angleDeg(a.x, a.y, b.x, b.y);
      ctx.save();
      ctx.globalAlpha = 0.5;
      stroke(ctx, { x1: a.x, y1: a.y, x2: a.x + Math.sign(b.x - a.x || 1) * 40, y2: a.y },
        style, 0, { width: 1, dash: true });
      ctx.beginPath();
      ctx.strokeStyle = style.color;
      ctx.lineWidth = 1;
      const from = b.x >= a.x ? 0 : Math.PI;
      const to = -deg * Math.PI / 180;
      ctx.arc(a.x, a.y, 26, Math.min(from, to), Math.max(from, to));
      ctx.stroke();
      ctx.restore();
      tag(ctx, a.x + 26, a.y - 14, [`${deg.toFixed(1)}°`], style.color);
    }

    if (def.label === "info" && info && ready(pts, 2)) {
      tag(ctx, pts[1].x, pts[1].y, [
        `${fmtDelta(info.dPrice)} (${pct(info.dPct)})`,
        `${Math.abs(Math.round(info.dBars))}봉 · ${info.span}`,
      ], style.color);
    }

    if (selected) handles(ctx, pts, style.color);
  },

  hit(x, y, env, { segs }) {
    let best = null;
    for (const s of segs) {
      const d = distToSegment(x, y, s.x1, s.y1, s.x2, s.y2);
      if (best == null || d < best) best = d;
    }
    return best == null ? null : { d: best, priority: 1 };
  },

  box({ segs }, pts, pad) {
    const all = [...pts];
    segs.forEach((s) => all.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }));
    return bboxOf(all, pad);
  },
};

/* ── 기하 2: 채널 ───────────────────────────
   네 채널이 다른 건 "두 번째 선을 어디서 얻느냐" 뿐이다. */

const SECOND = {
  /* 평행 채널 — ab 와 같은 방향, p3 를 지난다. 화면 좌표에서 계산하므로
     p1·p2 를 끌어 기울기가 바뀌어도 평행이 유지된다. */
  parallel: ({ pts }) => (ready(pts, 3)
    ? parallelThrough(pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y) : null),

  /* 수평 상단/하단 — 한쪽만 수평. 상승·하강 삼각형에 쓴다. */
  flat: ({ pts }) => (ready(pts, 3)
    ? flatThrough(pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].y) : null),

  /* 평행하지 않은 채널 — 두 선이 완전히 독립 */
  free: ({ pts }) => (ready(pts, 4)
    ? { x1: pts[2].x, y1: pts[2].y, x2: pts[3].x, y2: pts[3].y } : null),
};

const CHANNEL = {
  shape(env) {
    const { pts, def, style, map, candles, logicals, w, h } = env;
    if (def.regression) return CHANNEL._regression(env);
    if (!ready(pts, 2)) return { segs: [] };
    const base = { x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y };
    const other = SECOND[def.second]?.(env) || null;
    const clip = (s) => (s ? clipLine(s.x1, s.y1, s.x2, s.y2, def.extendLeft, def.extendRight, w, h, CLIP_PAD) : null);
    const a = clip(base), b = clip(other);
    return {
      segs: [a, b].filter(Boolean),
      poly: a && b ? [{ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { x: b.x2, y: b.y2 }, { x: b.x1, y: b.y1 }] : null,
    };
  },

  /* 회귀 추세만 부류가 다르다. 앵커가 아니라 구간 안의 종가에서 선이 나오므로
     캔들과 좌표 변환기가 필요하다. 봉 간격을 바꾸면 표본이 바뀌어 선도 바뀌는데,
     이건 버그가 아니라 TradingView 와 같은 정상 동작이다. */
  _regression({ pts, def, style, map, candles, logicals, w, h }) {
    if (!ready(pts, 2) || !map || !candles?.length) return { segs: [] };
    let i0 = Math.round(Math.min(logicals[0], logicals[1]));
    let i1 = Math.round(Math.max(logicals[0], logicals[1]));
    i0 = Math.max(0, Math.min(candles.length - 1, i0));
    i1 = Math.max(0, Math.min(candles.length - 1, i1));
    if (i1 - i0 < 2) return { segs: [] };

    const vals = [];
    for (let i = i0; i <= i1; i++) vals.push(candles[i].close);
    const fit = linregFit(vals);
    if (!fit) return { segs: [] };

    const n = vals.length - 1;
    const m = Number(style.mult) || 2;
    const at = (k, off) => ({ x: map.x(i0 + k), y: map.y(fit.intercept + fit.slope * k + off) });
    const line = (off) => {
      const p = at(0, off), q = at(n, off);
      if (p.x == null || p.y == null || q.x == null || q.y == null) return null;
      const s = { x1: p.x, y1: p.y, x2: q.x, y2: q.y };
      return clipLine(s.x1, s.y1, s.x2, s.y2, def.extendLeft, def.extendRight, w, h, CLIP_PAD);
    };
    const up = line(m * fit.sd), mid = line(0), lo = line(-m * fit.sd);
    return {
      segs: [up, mid, lo].filter(Boolean),
      poly: up && lo ? [{ x: up.x1, y: up.y1 }, { x: up.x2, y: up.y2 }, { x: lo.x2, y: lo.y2 }, { x: lo.x1, y: lo.y1 }] : null,
      extra: { r: fit.r, mid },
    };
  },

  draw(ctx, { pts, def, style, selected, hovered }, { segs, poly, extra }) {
    const boost = selected || hovered ? 1 : 0;
    if (style.fill !== false && poly) fillPoly(ctx, poly, alpha(style.color, 0.1));
    segs.forEach((s, i) => {
      // 회귀 추세의 가운데 선은 얇은 점선으로 구분한다
      const mid = def.regression && i === 1;
      stroke(ctx, s, style, boost, mid ? { width: 1, dash: true } : {});
    });
    if (def.regression && style.showR !== false && extra?.mid && extra.r != null) {
      tag(ctx, extra.mid.x2, extra.mid.y2, [`R ${extra.r.toFixed(2)}`], style.color, "right");
    }
    if (selected) handles(ctx, pts, style.color);
  },

  hit(x, y, env, { segs, poly }) {
    let best = null;
    for (const s of segs) {
      const d = distToSegment(x, y, s.x1, s.y1, s.x2, s.y2);
      if (best == null || d < best) best = d;
    }
    if (best != null) return { d: best, priority: 1 };
    // 몸통은 면이라 우선순위가 낮다 — 채널 위에 그은 추세선을 여전히 잡을 수 있게
    return inPoly(x, y, poly) ? { d: 0, priority: 0 } : null;
  },

  box({ segs, poly }, pts, pad) {
    const all = [...pts, ...(poly || [])];
    segs.forEach((s) => all.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }));
    return bboxOf(all, pad);
  },
};

/* ── 기하 3: 피보나치 ───────────────────────
   되돌림은 2점(구간), 확장은 3점(충격 + 되돌림 끝)에서 투영한다. */

const RETRACE = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const EXTEND = [0, 0.382, 0.618, 1, 1.272, 1.618, 2.618];

const FIB = {
  shape({ pts, def, style, map, w, anchors }) {
    const n = def.points;
    if (!ready(pts, n) || !map || !anchors || anchors.length < n) return { segs: [] };
    // 확장은 p3 에서 (p2-p1) 만큼을 배수로 투영하고, 되돌림은 구간을 나눈다
    const prices = def.projected
      ? def.levels.map((level) => ({
        level,
        price: anchors[2].price + (anchors[1].price - anchors[0].price) * level,
      }))
      : fibLevels(anchors[0].price, anchors[1].price, def.levels);

    const xs = pts.slice(0, n).map((p) => p.x);
    const x1 = Math.min(...xs);
    const x2 = style.extendRight === false ? Math.max(...xs) : w + CLIP_PAD;
    const rows = prices.map((r) => {
      const y = map.y(r.price);
      return y == null ? null : { ...r, y };
    }).filter(Boolean);
    return {
      segs: rows.map((r) => ({ x1, y1: r.y, x2, y2: r.y })),
      poly: rows.length >= 2
        ? [{ x: x1, y: rows[0].y }, { x: x2, y: rows[0].y },
           { x: x2, y: rows[rows.length - 1].y }, { x: x1, y: rows[rows.length - 1].y }]
        : null,
      extra: { rows, x1, x2 },
    };
  },

  draw(ctx, { pts, style, selected, hovered }, { extra }) {
    if (!extra?.rows?.length) return;
    const { rows, x1, x2 } = extra;
    const boost = selected || hovered ? 1 : 0;
    if (style.fill !== false) {
      for (let i = 0; i + 1 < rows.length; i++) {
        if (i % 2) continue;                       // 한 칸 걸러 칠해야 눈금이 읽힌다
        fillPoly(ctx, [
          { x: x1, y: rows[i].y }, { x: x2, y: rows[i].y },
          { x: x2, y: rows[i + 1].y }, { x: x1, y: rows[i + 1].y },
        ], alpha(style.color, 0.07));
      }
    }
    rows.forEach((r) => {
      stroke(ctx, { x1, y1: r.y, x2, y2: r.y }, style, boost, { width: r.level === 0 || r.level === 1 ? 2 : 1 });
      label(ctx, x1 + 4, r.y - 2, `${r.level} (${fmtPrice(r.price)})`, style.color);
    });
    if (selected) handles(ctx, pts, style.color);
  },

  hit(x, y, env, { segs, poly }) {
    let best = null;
    for (const s of segs) {
      const d = distToSegment(x, y, s.x1, s.y1, s.x2, s.y2);
      if (best == null || d < best) best = d;
    }
    if (best != null) return { d: best, priority: 1 };
    return inPoly(x, y, poly) ? { d: 0, priority: 0 } : null;
  },

  box({ segs, poly }, pts, pad) {
    const all = [...pts, ...(poly || [])];
    segs.forEach((s) => all.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }));
    return bboxOf(all, pad);
  },
};

/* ── 기하 4: 롱·숏 포지션 ───────────────────
   앵커 3개 — 진입 · 목표 · 손절. 이 앱의 계산기와 같은 값을 화면에서 본다. */

const POSITION = {
  shape({ pts }) {
    if (!ready(pts, 3)) return { segs: [] };
    const [e, t, s] = pts;
    const x1 = Math.min(e.x, t.x), x2 = Math.max(e.x, t.x);
    const rect = (ya, yb) => [
      { x: x1, y: ya }, { x: x2, y: ya }, { x: x2, y: yb }, { x: x1, y: yb },
    ];
    return {
      segs: [
        { x1, y1: e.y, x2, y2: e.y },
        { x1, y1: t.y, x2, y2: t.y },
        { x1, y1: s.y, x2, y2: s.y },
      ],
      poly: rect(Math.min(t.y, s.y), Math.max(t.y, s.y)),
      extra: { x1, x2, profit: rect(e.y, t.y), loss: rect(e.y, s.y) },
    };
  },

  draw(ctx, { pts, def, style, selected, hovered, anchors }, { segs, extra }) {
    if (!extra) return;
    const boost = selected || hovered ? 1 : 0;
    fillPoly(ctx, extra.profit, alpha(UP, 0.14));
    fillPoly(ctx, extra.loss, alpha(DOWN, 0.14));
    stroke(ctx, segs[0], style, boost, { color: style.color, width: 1, dash: true });
    stroke(ctx, segs[1], style, boost, { color: UP, dash: false });
    stroke(ctx, segs[2], style, boost, { color: DOWN, dash: false });

    if (anchors && anchors.length >= 3) {
      const entry = anchors[0].price, target = anchors[1].price, stop = anchors[2].price;
      const risk = Math.abs(entry - stop);
      const rr = risk > 0 ? Math.abs(target - entry) / risk : 0;
      const pc = (v) => (entry ? ((v - entry) / entry) * 100 * (def.dir || 1) : 0);
      tag(ctx, extra.x2, pts[1].y, [`목표 ${pct(pc(target))}`, fmtPrice(target)], UP);
      tag(ctx, extra.x2, pts[2].y, [`손절 ${pct(pc(stop))}`, fmtPrice(stop)], DOWN);
      tag(ctx, extra.x1, pts[0].y, [
        `${def.dir === 1 ? "롱" : "숏"} · R:R ${rr.toFixed(2)}`,
        `진입 ${fmtPrice(entry)}`,
      ], style.color, "right");
    }
    if (selected) handles(ctx, pts, style.color);
  },

  hit(x, y, env, { segs, poly }) {
    let best = null;
    for (const s of segs) {
      const d = distToSegment(x, y, s.x1, s.y1, s.x2, s.y2);
      if (best == null || d < best) best = d;
    }
    if (best != null) return { d: best, priority: 1 };
    return inPoly(x, y, poly) ? { d: 0, priority: 0 } : null;
  },

  box({ poly }, pts, pad) { return bboxOf([...pts, ...(poly || [])], pad); },
};

/* ── 기하 5: 상자 (사각형 · 측정자) ────────── */

const BOX = {
  shape({ pts }) {
    if (!ready(pts, 2)) return { segs: [] };
    const [a, b] = pts;
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    const poly = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
    return {
      segs: [
        { x1, y1, x2, y2: y1 }, { x1: x2, y1, x2, y2 },
        { x1, y1: y2, x2, y2 }, { x1, y1, x2: x1, y2 },
      ],
      poly,
      extra: { x1, x2, y1, y2 },
    };
  },

  draw(ctx, { pts, def, style, selected, hovered, info }, { segs, poly, extra }) {
    if (!extra) return;
    const boost = selected || hovered ? 1 : 0;
    const up = def.ruler && info ? info.dPrice >= 0 : true;
    const col = def.ruler ? (up ? UP : DOWN) : style.color;

    if (style.fill !== false) fillPoly(ctx, poly, alpha(col, def.ruler ? 0.12 : 0.09));
    segs.forEach((s) => stroke(ctx, s, style, boost, { color: col }));

    if (def.ruler && info && ready(pts, 2)) {
      // 방향 화살표 — 어디서 어디로 잰 것인지 한눈에 보이게
      const [a, b] = pts;
      ctx.save();
      ctx.globalAlpha = 0.8;
      stroke(ctx, { x1: a.x, y1: a.y, x2: b.x, y2: b.y }, style, 0, { color: col, width: 1 });
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - 8 * Math.cos(ang - 0.4), b.y - 8 * Math.sin(ang - 0.4));
      ctx.lineTo(b.x - 8 * Math.cos(ang + 0.4), b.y - 8 * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();
      tag(ctx, (extra.x1 + extra.x2) / 2, extra.y1 - 14, [
        `${fmtDelta(info.dPrice)} (${pct(info.dPct)})`,
        `${Math.abs(Math.round(info.dBars))}봉 · ${info.span}`,
      ], col);
    }
    if (selected) handles(ctx, pts, style.color);
  },

  hit(x, y, env, { segs, poly }) {
    let best = null;
    for (const s of segs) {
      const d = distToSegment(x, y, s.x1, s.y1, s.x2, s.y2);
      if (best == null || d < best) best = d;
    }
    if (best != null) return { d: best, priority: 1 };
    return inPoly(x, y, poly) ? { d: 0, priority: 0 } : null;
  },

  box({ poly }, pts, pad) { return bboxOf([...pts, ...(poly || [])], pad); },
};

export const KINDS = { line: LINE, channel: CHANNEL, fib: FIB, position: POSITION, box: BOX };

/* ── 아이콘 (16×16 viewBox) ────────────────── */
const I = {
  trend: "M2.5 13.5L13.5 2.5",
  ray: "M2.5 13.5L13.5 2.5",
  extended: "M1 15L15 1",
  info: "M2.5 13.5L13.5 2.5",
  angle: "M2.5 13.5L13.5 2.5M2.5 13.5H12M6 13.5a5 5 0 0 0 1.2-3",
  hline: "M2 8h12",
  hray: "M3 8h11",
  vline: "M8 2v12",
  cross: "M2 8h12M8 2v12",
  parallel: "M2 11L11 2M5 14L14 5",
  regression: "M2 12.5L14 4.5M2 8.5L14 .5M2 15.5L14 7.5",
  flat: "M2 13L13 3M2 3h11",
  free: "M2 12L13 3M3 15L14 8",
  fibRetrace: "M2 3h12M2 6.5h12M2 10h12M2 13.5h12",
  fibExtend: "M2 13.5L8 8l6 3M2 3h12M2 6.5h12",
  long: "M2 11h12M2 6h12M4 13.5V3.5",
  short: "M2 5h12M2 10h12M4 2.5v11",
  rect: "M2.5 3.5h11v9h-11z",
  ruler: "M2 10.5L10.5 2l3.5 3.5L5.5 14z M5 5.5l1.5 1.5M7.5 3l1.5 1.5",
};
const D = {
  trend: [[2.5, 13.5], [13.5, 2.5]],
  ray: [[2.5, 13.5]],
  extended: [[5.5, 10.5], [10.5, 5.5]],
  info: [[2.5, 13.5], [13.5, 2.5]],
  angle: [[2.5, 13.5], [13.5, 2.5]],
  hline: [[2, 8], [14, 8]],
  hray: [[3, 8]],
  vline: [[8, 8]],
  cross: [[8, 8]],
  parallel: [[2, 11], [11, 2]],
  regression: [],
  flat: [[2, 13], [13, 3]],
  free: [[2, 12], [13, 3]],
  fibRetrace: [],
  fibExtend: [],
  long: [],
  short: [],
  rect: [],
  ruler: [],
};

/* ── 레지스트리 ─────────────────────────────
   전부 순수 데이터다. 도구를 늘려도 UI 코드는 바뀌지 않는다. */

const base = (id, name, group, kind, flags) => ({
  id, name, group, kind,
  shortcut: null,
  icon: I[id] || I.trend,
  dots: D[id] || [],
  params: LINE_PARAMS,
  points: 2,
  extendLeft: false,
  extendRight: false,
  horizontal: false,
  vertical: false,
  label: null,
  derive: null,
  ...flags,
});

const line = (id, name, shortcut, flags) => base(id, name, "line", "line", { shortcut, ...flags });

/* 기울기가 0 이면 폭을 못 정하므로 화면 60px 아래에 두 번째 선을 만든다.
   그 뒤로는 사용자가 세 번째 핸들을 끌어 조절한다. */
const widen = (n) => (pts, api) => {
  const [a, b] = pts;
  const p3 = { time: a.time, price: api.offsetPrice(a.price, 60) };
  if (n === 3) return [a, b, p3];
  return [a, b, p3, { time: b.time, price: api.offsetPrice(b.price, 60) }];
};

export const REGISTRY = [
  // ── 라인 9종
  line("trend", "추세선", "alt+t", {}),
  line("ray", "레이", null, { extendRight: true }),
  line("info", "정보 라인", null, { label: "info" }),
  line("extended", "연장선", null, { extendLeft: true, extendRight: true }),
  line("angle", "추세 각도", null, { label: "angle" }),
  line("hline", "수평선", "alt+h", { points: 1, horizontal: true, extendLeft: true, extendRight: true }),
  line("hray", "수평 레이", "alt+j", { points: 1, horizontal: true, extendRight: true }),
  line("vline", "수직선", "alt+v", { points: 1, vertical: true }),
  line("cross", "크로스라인", "alt+c", { points: 1, horizontal: true, vertical: true, extendLeft: true, extendRight: true }),

  // ── 채널 4종 — 두 번째 선을 얻는 방법만 다르다
  base("parallel", "평행 채널", "channel", "channel", { points: 3, second: "parallel", params: FILLED, derive: widen(3) }),
  base("regression", "회귀 추세", "channel", "channel", { points: 2, regression: true, params: REG_PARAMS }),
  base("flat", "수평 상단/하단", "channel", "channel", { points: 3, second: "flat", params: FILLED, derive: widen(3) }),
  base("free", "평행하지 않은 채널", "channel", "channel", { points: 4, second: "free", params: FILLED, derive: widen(4) }),

  // ── 피보나치
  base("fibRetrace", "피보나치 되돌림", "fib", "fib", { points: 2, levels: RETRACE, params: FIB_PARAMS }),
  base("fibExtend", "피보나치 확장", "fib", "fib", {
    points: 3, levels: EXTEND, projected: true, params: FIB_PARAMS,
    derive: (pts) => {
      const [a, b] = pts;
      return [a, b, { time: b.time + (b.time - a.time) * 0.4, price: a.price + (b.price - a.price) * 0.5 }];
    },
  }),

  // ── 예측 · 측정
  ...[["long", "롱 포지션", 1], ["short", "숏 포지션", -1]].map(([id, name, dir]) =>
    base(id, name, "forecast", "position", {
      points: 3, dir,
      /* 끈 거리를 목표로, 그 절반을 손절로 잡아 R:R 2 로 시작한다.
         방향은 도구가 정한다 — 롱 도구로 아래로 끌어도 롱 상자가 나온다. */
      derive: (pts) => {
        const [a, b] = pts;
        const d = Math.abs(b.price - a.price) || Math.abs(a.price * 0.01);
        return [a, { time: b.time, price: a.price + dir * d }, { time: b.time, price: a.price - dir * d / 2 }];
      },
    })),
  base("ruler", "측정자", "forecast", "box", { ruler: true, params: FILLED }),

  // ── 도형
  base("rect", "사각형", "shape", "box", { params: FILLED }),
];

export const GROUPS = [
  { id: "line", name: "라인" },
  { id: "channel", name: "채널" },
  { id: "fib", name: "피보나치" },
  { id: "forecast", name: "예측 · 측정" },
  { id: "shape", name: "도형" },
];

const BY_ID = new Map(REGISTRY.map((d) => [d.id, d]));
export const byId = (id) => BY_ID.get(id) || null;

/* 정보 라인·측정자가 쓰는 값이 필요한 도구 */
export const needsInfo = (def) => def?.label === "info" || def?.ruler === true;
/* 포지션 도구는 앵커의 가격 원본이 필요하다 (화면 좌표로는 %·R:R 을 못 낸다) */
export const needsPrices = (def) => def?.kind === "position";
/* 피보나치는 앵커 가격에서 레벨을 만든다 */
export const needsAnchors = (def) => def?.kind === "fib";

/* "alt+t" → 도구 id. 단축키는 TradingView 와 같게 맞췄다. */
export const SHORTCUTS = new Map(
  REGISTRY.filter((d) => d.shortcut).map((d) => [d.shortcut, d.id])
);
export function shortcutOf(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  const k = String(e.key || "").toLowerCase();
  return SHORTCUTS.get(`alt+${k}`) || null;
}
