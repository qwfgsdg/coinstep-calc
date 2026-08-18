/* ═══════════════════════════════════════════
   그리기 기하 (순수 함수)

   lightweight-charts 를 import 하지 않는다. 전부 입력→출력이라
   브라우저 없이 `npm test` 로 검증된다. 그리기 버그의 대부분이 좌표 수학에서
   나오는데 그것만 자동 검증이 가능하므로, 렌더·상태에서 떼어 여기 모았다.

   ESM(.mjs)인 이유: package.json 에 type:module 이 없어 .js 는 node 가 CJS 로
   읽는다. 확장자를 붙여 import 하면 Next 도 그대로 번들한다.

   좌표 규약
     logical  봉 인덱스. 소수 허용(봉 사이). 데이터 밖은 외삽해 음수·초과가 나온다.
     time     캔들과 같은 축 — 이미 KST_SHIFT(+9h) 가 적용된 값. 여기서 또 밀지 않는다.
     x, y     화면(CSS) 픽셀. y 는 아래로 증가한다.
   ═══════════════════════════════════════════ */

/* ── 봉 간격 ─────────────────────────────────
   누락된 봉이 있어도 흔들리지 않게 최근 구간의 중앙값을 쓴다. */
export function barSecOf(candles) {
  const n = candles?.length || 0;
  if (n < 2) return 60;
  const d = [];
  for (let i = Math.max(1, n - 20); i < n; i++) {
    const v = candles[i].time - candles[i - 1].time;
    if (v > 0) d.push(v);
  }
  if (d.length === 0) return 60;
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

/* ── 시각 ↔ 봉 인덱스 ────────────────────────
   앵커를 logical 로 저장하면 안 되는 이유: 캔들 로더가 limit=500 창을 계속
   슬라이드시켜 새 봉마다 인덱스가 통째로 1씩 밀린다. 저장은 time 으로 하고
   그릴 때마다 여기서 인덱스로 바꾼다. 데이터 밖(미래로 뻗은 추세선)은 외삽. */
export function timeToLogical(time, candles, barSec) {
  const n = candles?.length || 0;
  if (n === 0) return null;
  const b = barSec || barSecOf(candles);
  const last = n - 1;
  if (time <= candles[0].time) return (time - candles[0].time) / b;
  if (time >= candles[last].time) return last + (time - candles[last].time) / b;
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= time) lo = mid; else hi = mid;
  }
  const span = candles[hi].time - candles[lo].time;
  return span > 0 ? lo + (time - candles[lo].time) / span : lo;
}

export function logicalToTime(logical, candles, barSec) {
  const n = candles?.length || 0;
  if (n === 0) return null;
  const b = barSec || barSecOf(candles);
  const last = n - 1;
  if (logical <= 0) return Math.round(candles[0].time + logical * b);
  if (logical >= last) return Math.round(candles[last].time + (logical - last) * b);
  const i = Math.floor(logical);
  return Math.round(candles[i].time + (logical - i) * (candles[i + 1].time - candles[i].time));
}

/* ── 소수 인덱스 → x ─────────────────────────
   timeScale().logicalToCoordinate() 는 소수 인덱스에 null 이나 예외가 아니라
   조용히 0(차트 왼쪽 끝) 을 돌려준다.
     lightweight-charts 6134행:  if (isEmpty() || !isInteger(index)) return 0;
   반환식 width - (base + rightOffset - index + 0.5)*barSpacing - 1 은 index 에
   대해 선형이고 기울기가 정확히 barSpacing 이므로, 정수 좌표에서 직접 보간하면
   라이브러리 값과 일치한다. 그리기는 반드시 이 함수를 거친다. */
export const subBarX = (floorCoord, frac, barSpacing) => floorCoord + frac * barSpacing;

/* ── x → 소수 인덱스 ─────────────────────────
   역변환도 라이브러리 것을 못 쓴다. coordinateToLogical(x) 는
     _internal_coordinateToIndex → Math.ceil(floatIndex)
   라 정수로 올림된다. 드래그에 쓰면 앵커가 봉 경계로 튀고 반 봉만큼 치우친다.
   좌표식이 선형이므로 기준점 하나(logicalToCoordinate(0))와 기울기(barSpacing)로
   정확히 되돌린다. subBarX 의 역함수다. */
export const logicalOfX = (x, coordAtZero, barSpacing) =>
  barSpacing === 0 ? 0 : (x - coordAtZero) / barSpacing;

/* ── 점과 선 ─────────────────────────────────
   projT: 선 ab 위로 p 를 정사영한 매개변수. 0=a, 1=b. */
function projT(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const dd = dx * dx + dy * dy;
  return dd === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / dd;
}
const distAt = (px, py, ax, ay, bx, by, t) =>
  Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));

/** 선분까지의 거리.
    레이·연장선·수평선처럼 무한히 뻗는 도구도 clipLine 으로 화면 밖까지 잘라
    선분으로 만든 뒤 잡는다. 그래서 히트 판정은 이 하나로 끝난다. */
export function distToSegment(px, py, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, projT(px, py, ax, ay, bx, by)));
  return distAt(px, py, ax, ay, bx, by, t);
}

/* ── 연장 클리핑 (Liang–Barsky) ───────────────
   라인 9종이 전부 이 하나로 처리된다. extendLeft/Right 플래그만 다르다.
   화면 밖으로 한참 나간 좌표를 캔버스에 넘기면 느려지므로 여유를 두고 자른다. */
export function clipLine(ax, ay, bx, by, extendLeft, extendRight, w, h, margin = 2000) {
  const dx = bx - ax, dy = by - ay;
  const same = { x1: ax, y1: ay, x2: bx, y2: by };
  if (dx === 0 && dy === 0) return same;
  if (!extendLeft && !extendRight) return same;

  const lo = -margin, hiX = w + margin, hiY = h + margin;
  let tMin = -Infinity, tMax = Infinity;
  const slabs = [[-dx, ax - lo], [dx, hiX - ax], [-dy, ay - lo], [dy, hiY - ay]];
  for (const [p, q] of slabs) {
    if (p === 0) { if (q < 0) return same; continue; }   // 방향과 평행 + 밖 → 자르지 않는다
    const t = q / p;
    if (p < 0) { if (t > tMin) tMin = t; }
    else if (t < tMax) tMax = t;
  }
  if (tMin > tMax) return same;

  const t0 = extendLeft ? Math.min(0, tMin) : 0;
  const t1 = extendRight ? Math.max(1, tMax) : 1;
  return { x1: ax + t0 * dx, y1: ay + t0 * dy, x2: ax + t1 * dx, y2: ay + t1 * dy };
}

/* ── 채널 ───────────────────────────────────
   네 채널이 다른 건 "두 번째 선을 어디서 얻느냐" 뿐이다. */

/** 평행 채널 — ab 와 같은 방향, c 를 지난다. 화면 좌표에서 계산하므로
    p1·p2 를 끌어 기울기가 바뀌어도 평행이 유지된다. */
export function parallelThrough(ax, ay, bx, by, cx, cy) {
  const t = projT(cx, cy, ax, ay, bx, by);
  const ox = cx - (ax + t * (bx - ax));
  const oy = cy - (ay + t * (by - ay));
  return { x1: ax + ox, y1: ay + oy, x2: bx + ox, y2: by + oy };
}
/** 수평 상단/하단 — 두 번째 선이 수평 */
export const flatThrough = (ax, _ay, bx, _by, cy) => ({ x1: ax, y1: cy, x2: bx, y2: cy });

/* ── 다각형 안쪽 판정 (ray casting) ───────────
   채널의 몸통·사각형·피보나치 띠를 "면" 으로 잡을 때 쓴다. 면은 선보다 히트
   우선순위가 낮아야(0) 채널 위에 그은 추세선을 여전히 잡을 수 있다. */
export function inPoly(px, py, poly) {
  if (!poly || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (!a || !b) return false;
    if ((a.y > py) !== (b.y > py)
      && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/* ── 최소자승 회귀 ───────────────────────────
   ta.js 의 linreg 는 롤링(마지막 봉 값)이라 못 쓴다. 구간 고정 적합이 필요하다.
   sd 는 잔차 표준편차 — 회귀 추세 채널의 상·하 폭. r 은 피어슨 상관계수. */
export function linregFit(values) {
  const n = values?.length || 0;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const y = values[i];
    sx += i; sy += y; sxy += i * y; sxx += i * i; syy += y * y;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = values[i] - (intercept + slope * i); ss += d * d; }
  const rden = Math.sqrt(den * (n * syy - sy * sy));
  return {
    slope, intercept,
    sd: Math.sqrt(ss / n),
    r: rden === 0 ? 0 : (n * sxy - sx * sy) / rden,
  };
}

/* ── 피보나치 ───────────────────────────────── */
export const fibLevels = (p0, p1, levels) =>
  levels.map((level) => ({ level, price: p0 + (p1 - p0) * level }));

/* ── 자석 ───────────────────────────────────
   CrosshairMode.Magnet 은 십자선만 붙지 앵커는 안 붙는다. 직접 스냅한다.
   가격이 아니라 화면 거리로 판정해야 코인마다 임계값을 바꾸지 않는다. */
export function magnetPrice(price, bar, toY, thresholdPx = 8) {
  if (!bar) return price;
  const y0 = toY(price);
  if (y0 == null) return price;
  let best = price, bestD = thresholdPx;
  for (const v of [bar.open, bar.high, bar.low, bar.close]) {
    const y = toY(v);
    if (y == null) continue;
    const d = Math.abs(y - y0);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

/* ── 그 외 ─────────────────────────────────── */
/** 추세 각도. 화면 y 는 아래로 증가하므로 뒤집는다. */
export const angleDeg = (ax, ay, bx, by) => (Math.atan2(ay - by, bx - ax) * 180) / Math.PI;

/** 잡을 앵커 찾기. 못 잡으면 -1 */
export function nearestAnchorIdx(px, py, pts, radius = 7) {
  let idx = -1, best = radius;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p || p.x == null || p.y == null) continue;
    const d = Math.hypot(px - p.x, py - p.y);
    if (d <= best) { best = d; idx = i; }
  }
  return idx;
}

/** hitTest 선검사용. 여기서 걸러야 매 mousemove 마다 도는 거리 계산이 줄어든다. */
export function bboxOf(pts, pad = 0) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of pts) {
    if (!p || p.x == null || p.y == null) continue;
    if (p.x < x1) x1 = p.x;
    if (p.x > x2) x2 = p.x;
    if (p.y < y1) y1 = p.y;
    if (p.y > y2) y2 = p.y;
  }
  if (x1 === Infinity) return null;
  return { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad };
}
export const inBox = (px, py, b) =>
  b != null && px >= b.x1 && px <= b.x2 && py >= b.y1 && py <= b.y2;
