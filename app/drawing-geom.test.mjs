/* 그리기 기하 단위 테스트 — `npm test`
   브라우저 없이 도는 유일한 층이다. 채널·피보나치·라인 9종의 수학이 전부
   여기 걸려 있으므로, 구현을 넓히기 전에 여기부터 초록불을 만든다. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  barSecOf, timeToLogical, logicalToTime, subBarX, logicalOfX,
  distToSegment, clipLine,
  parallelThrough, flatThrough, linregFit, fibLevels, inPoly,
  magnetPrice, angleDeg, nearestAnchorIdx, bboxOf, inBox,
} from "./drawing-geom.mjs";

const near = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !== ${b} (오차 ${Math.abs(a - b)})`);

// 15분봉 100개. time 은 캔들과 같은 축(KST_SHIFT 적용 후)이라고 가정한다.
const T0 = 1700000000 + 9 * 3600;
const BAR = 900;
const candles = Array.from({ length: 100 }, (_, i) => ({
  time: T0 + i * BAR,
  open: 100 + i, high: 105 + i, low: 95 + i, close: 102 + i,
}));

/* ── 봉 간격 ── */

test("barSecOf — 균일한 봉", () => {
  assert.equal(barSecOf(candles), BAR);
});

test("barSecOf — 봉이 빠져도 중앙값이라 흔들리지 않는다", () => {
  const gapped = candles.map((c, i) => (i === 95 ? { ...c, time: c.time + BAR * 5 } : c));
  assert.equal(barSecOf(gapped), BAR);
});

test("barSecOf — 캔들이 없거나 하나뿐이면 기본값", () => {
  assert.equal(barSecOf([]), 60);
  assert.equal(barSecOf(null), 60);
  assert.equal(barSecOf([candles[0]]), 60);
});

/* ── time ↔ logical ──
   여기가 틀리면 그림이 봉 주기마다 옆으로 기어간다. */

test("timeToLogical — 봉에 정확히 걸리면 정수", () => {
  near(timeToLogical(candles[0].time, candles, BAR), 0);
  near(timeToLogical(candles[42].time, candles, BAR), 42);
  near(timeToLogical(candles[99].time, candles, BAR), 99);
});

test("timeToLogical — 봉 사이는 소수", () => {
  near(timeToLogical(candles[10].time + BAR / 2, candles, BAR), 10.5);
  near(timeToLogical(candles[10].time + BAR / 4, candles, BAR), 10.25);
});

test("timeToLogical — 데이터 앞은 음수, 뒤는 초과 (외삽)", () => {
  near(timeToLogical(T0 - BAR * 3, candles, BAR), -3);
  near(timeToLogical(T0 - BAR * 2.5, candles, BAR), -2.5);
  near(timeToLogical(candles[99].time + BAR * 10, candles, BAR), 109);
  near(timeToLogical(candles[99].time + BAR * 7.5, candles, BAR), 106.5);
});

test("timeToLogical — 단조증가", () => {
  let prev = -Infinity;
  for (let t = T0 - BAR * 5; t < T0 + BAR * 110; t += BAR / 3) {
    const v = timeToLogical(t, candles, BAR);
    assert.ok(v > prev, `단조성 깨짐: t=${t} → ${v} (직전 ${prev})`);
    prev = v;
  }
});

test("timeToLogical — 캔들이 없으면 null", () => {
  assert.equal(timeToLogical(T0, [], BAR), null);
});

test("logicalToTime ∘ timeToLogical = 항등 (왕복)", () => {
  for (const L of [-7.25, -1, 0, 0.5, 13.75, 50, 98.5, 99, 104.5, 130]) {
    const t = logicalToTime(L, candles, BAR);
    near(timeToLogical(t, candles, BAR), L, 1e-6);
  }
});

test("timeToLogical ∘ logicalToTime = 항등 (역왕복)", () => {
  for (const t of [T0 - BAR * 4, T0, T0 + BAR * 33 + 100, candles[99].time, candles[99].time + BAR * 6]) {
    const L = timeToLogical(t, candles, BAR);
    assert.equal(logicalToTime(L, candles, BAR), t);
  }
});

/* ── subBarX — V2 회귀 테스트 ──
   lightweight-charts 6134행이 소수 인덱스에 0 을 반환하는 것을 우회하는 함수다.
   라이브러리 공식을 그대로 옮겨와, 정수 좌표에서 보간한 값이 진짜 공식과
   일치함을 증명한다. 이 테스트가 깨지면 라이브러리가 좌표식을 바꾼 것이다. */

const libX = (index, { width, base, rightOffset, barSpacing }) =>
  width - (base + rightOffset - index + 0.5) * barSpacing - 1;

test("subBarX — 라이브러리 좌표식과 일치 (소수 인덱스 포함)", () => {
  const cfg = { width: 800, base: 99, rightOffset: 5, barSpacing: 6.5 };
  for (const i of [-12.5, -1.25, 0, 0.5, 3.125, 42.75, 99, 104.5, 130.9]) {
    const f = Math.floor(i);
    near(subBarX(libX(f, cfg), i - f, cfg.barSpacing), libX(i, cfg), 1e-9);
  }
});

test("subBarX — 정수 인덱스면 라이브러리 값을 그대로 통과시킨다", () => {
  const cfg = { width: 640, base: 200, rightOffset: 0, barSpacing: 12 };
  for (const i of [-5, 0, 77, 200]) {
    assert.equal(subBarX(libX(i, cfg), 0, cfg.barSpacing), libX(i, cfg));
  }
});

test("subBarX — 간격이 곧 기울기다", () => {
  near(subBarX(100, 1, 8) - subBarX(100, 0, 8), 8);
  near(subBarX(100, 0.5, 8) - subBarX(100, 0, 8), 4);
});

/* logicalOfX — 역변환. 라이브러리 coordinateToLogical 은 Math.ceil 로 정수를
   돌려주므로(6152행) 드래그에 쓰면 앵커가 봉 경계로 튄다. 직접 되돌린다. */

test("logicalOfX — 라이브러리 좌표식의 정확한 역함수", () => {
  const cfg = { width: 800, base: 99, rightOffset: 5, barSpacing: 6.5 };
  const x0 = libX(0, cfg);
  for (const i of [-12.5, -1.25, 0, 0.5, 3.125, 42.75, 99, 104.5, 130.9]) {
    near(logicalOfX(libX(i, cfg), x0, cfg.barSpacing), i, 1e-9);
  }
});

test("logicalOfX ∘ subBarX = 항등 (왕복)", () => {
  const cfg = { width: 640, base: 200, rightOffset: 3, barSpacing: 9.25 };
  const x0 = libX(0, cfg);
  for (const i of [-8.75, 0, 17.5, 199, 233.25]) {
    const f = Math.floor(i);
    const x = subBarX(libX(f, cfg), i - f, cfg.barSpacing);
    near(logicalOfX(x, x0, cfg.barSpacing), i, 1e-9);
  }
});

test("logicalOfX — 라이브러리는 올림해서 반 봉이 치우친다 (우리가 안 쓰는 이유)", () => {
  const cfg = { width: 800, base: 99, rightOffset: 0, barSpacing: 10 };
  const x0 = libX(0, cfg);
  const x = libX(42.4, cfg);
  near(logicalOfX(x, x0, cfg.barSpacing), 42.4, 1e-9);
  assert.equal(Math.ceil(logicalOfX(x, x0, cfg.barSpacing)), 43);  // 라이브러리 반환값
});

test("logicalOfX — barSpacing 0 에서 0 나눗셈 없음", () => {
  assert.equal(logicalOfX(500, 100, 0), 0);
});

/* ── 점과 선 ── */

test("distToSegment — 선분 끝 너머는 끝점까지의 거리", () => {
  near(distToSegment(5, 3, 0, 0, 10, 0), 3);      // 선분 안 → 수직거리
  near(distToSegment(-4, 3, 0, 0, 10, 0), 5);     // 왼쪽 밖 → a 까지 (3-4-5)
  near(distToSegment(14, 3, 0, 0, 10, 0), 5);     // 오른쪽 밖 → b 까지
});

test("길이 0 인 선분 — 0 나눗셈 없이 점까지의 거리", () => {
  near(distToSegment(3, 4, 0, 0, 0, 0), 5);
  near(distToSegment(3, 4, 7, 7, 7, 7), 5);
});

/* 무한히 뻗는 도구도 clipLine 으로 화면 밖까지 자른 뒤 잡는다.
   잘라 놓으면 화면 안에서는 무한 직선까지의 거리와 같다. */
test("자른 뒤에는 선분 거리 = 무한 직선 거리 (화면 안에서)", () => {
  const w = 800, h = 400;
  const s = clipLine(300, 200, 400, 200, true, true, w, h);   // 수평 연장선
  for (const [px, py] of [[10, 260], [790, 140], [400, 203]]) {
    near(distToSegment(px, py, s.x1, s.y1, s.x2, s.y2), Math.abs(py - 200), 1e-9);
  }
});

/* ── 연장 클리핑 ── */

test("clipLine — 연장 안 하면 원본 그대로", () => {
  const r = clipLine(10, 20, 30, 40, false, false, 800, 400);
  assert.deepEqual(r, { x1: 10, y1: 20, x2: 30, y2: 40 });
});

test("clipLine — 수평선 양방향 연장은 여백 포함 폭을 덮는다", () => {
  const r = clipLine(100, 50, 200, 50, true, true, 800, 400, 2000);
  near(r.y1, 50); near(r.y2, 50);
  assert.ok(r.x1 <= -2000 + 1e-9, `왼쪽 끝 ${r.x1}`);
  assert.ok(r.x2 >= 800 + 2000 - 1e-9, `오른쪽 끝 ${r.x2}`);
});

test("clipLine — 한쪽만 연장하면 반대쪽 원점은 유지 (레이)", () => {
  const r = clipLine(100, 50, 200, 100, false, true, 800, 400);
  near(r.x1, 100); near(r.y1, 50);
  assert.ok(r.x2 > 200);
});

test("clipLine — 연장해도 원래 선분을 항상 포함한다", () => {
  for (const [ax, ay, bx, by] of [[10, 10, 700, 380], [700, 380, 10, 10], [400, 0, 400, 400], [0, 200, 800, 200]]) {
    const r = clipLine(ax, ay, bx, by, true, true, 800, 400);
    const tOf = (x, y) => (Math.abs(bx - ax) > Math.abs(by - ay)
      ? (x - ax) / (bx - ax) : (y - ay) / (by - ay));
    assert.ok(tOf(r.x1, r.y1) <= 1e-9, "왼쪽 연장이 시작점을 넘어섰다");
    assert.ok(tOf(r.x2, r.y2) >= 1 - 1e-9, "오른쪽 연장이 끝점에 못 미친다");
  }
});

test("clipLine — 수직선 연장 (dx=0 에서 0 나눗셈 없음)", () => {
  const r = clipLine(400, 100, 400, 200, true, true, 800, 400, 2000);
  near(r.x1, 400); near(r.x2, 400);
  assert.ok(r.y1 <= -2000 + 1e-9 && r.y2 >= 400 + 2000 - 1e-9);
});

test("clipLine — 길이 0 이면 그대로", () => {
  assert.deepEqual(clipLine(5, 5, 5, 5, true, true, 800, 400), { x1: 5, y1: 5, x2: 5, y2: 5 });
});

/* ── 채널 ── */

test("parallelThrough — 평행이고 c 를 지난다", () => {
  const [ax, ay, bx, by, cx, cy] = [100, 300, 400, 100, 250, 320];
  const r = parallelThrough(ax, ay, bx, by, cx, cy);
  // 외적 0 → 평행
  near((bx - ax) * (r.y2 - r.y1) - (by - ay) * (r.x2 - r.x1), 0, 1e-9);
  // c 가 결과 직선 위에 있다
  near((r.x2 - r.x1) * (cy - r.y1) - (r.y2 - r.y1) * (cx - r.x1), 0, 1e-9);
  // x 범위가 원본과 같아야 채널로 채울 수 있다
  near(r.x2 - r.x1, bx - ax, 1e-9);
});

test("parallelThrough — 기울기를 바꿔도 평행이 유지된다 (p1·p2 드래그)", () => {
  for (const by of [100, 250, 300, 500]) {
    const r = parallelThrough(100, 300, 400, by, 250, 320);
    near((400 - 100) * (r.y2 - r.y1) - (by - 300) * (r.x2 - r.x1), 0, 1e-9);
  }
});

test("parallelThrough — c 가 이미 선 위면 제자리", () => {
  const r = parallelThrough(0, 0, 100, 100, 50, 50);
  near(r.x1, 0); near(r.y1, 0); near(r.x2, 100); near(r.y2, 100);
});

test("flatThrough — 두 번째 선이 수평이고 x 범위가 같다", () => {
  const r = flatThrough(100, 300, 400, 100, 220);
  assert.equal(r.y1, r.y2);
  assert.equal(r.y1, 220);
  assert.equal(r.x1, 100);
  assert.equal(r.x2, 400);
});

/* ── 다각형 안쪽 ── */

const P = (...xy) => xy.map(([x, y]) => ({ x, y }));

test("inPoly — 볼록 사각형", () => {
  const q = P([0, 0], [100, 0], [100, 50], [0, 50]);
  assert.ok(inPoly(50, 25, q));
  assert.ok(!inPoly(-1, 25, q));
  assert.ok(!inPoly(101, 25, q));
  assert.ok(!inPoly(50, 51, q));
});

test("inPoly — 기울어진 채널 몸통", () => {
  // 평행사변형 — 아래로 40 내려간 평행선 사이
  const q = P([0, 100], [200, 20], [200, 60], [0, 140]);
  assert.ok(inPoly(100, 80, q), "가운데는 안쪽");
  assert.ok(!inPoly(100, 20, q), "위쪽 밖");
  assert.ok(!inPoly(100, 140, q), "아래쪽 밖");
});

test("inPoly — 꼭짓점이 모자라거나 없으면 false", () => {
  assert.equal(inPoly(0, 0, null), false);
  assert.equal(inPoly(0, 0, []), false);
  assert.equal(inPoly(0, 0, P([0, 0], [1, 1])), false);
});

test("inPoly — 좌표가 없는 꼭짓점이 섞이면 false", () => {
  assert.equal(inPoly(5, 5, [{ x: 0, y: 0 }, { x: 10, y: 0 }, null]), false);
});

/* ── 회귀 ── */

test("linregFit — 완전한 직선이면 sd=0, r=1", () => {
  const v = Array.from({ length: 50 }, (_, i) => 10 + 2.5 * i);
  const f = linregFit(v);
  near(f.slope, 2.5, 1e-9);
  near(f.intercept, 10, 1e-9);
  near(f.sd, 0, 1e-9);
  near(f.r, 1, 1e-9);
});

test("linregFit — 내리막이면 r = -1", () => {
  const v = Array.from({ length: 30 }, (_, i) => 500 - 3 * i);
  const f = linregFit(v);
  near(f.slope, -3, 1e-9);
  near(f.r, -1, 1e-9);
});

test("linregFit — 평평하면 slope 0, r 0", () => {
  const f = linregFit(Array(20).fill(7));
  near(f.slope, 0);
  near(f.sd, 0);
  near(f.r, 0);
});

test("linregFit — 잔차 표준편차", () => {
  // 잡음이 적합에 흡수되지 않으려면 {1, i} 와 직교해야 한다. ±1 교대는
  // Σi·e = 20 이라 기울기를 밀어낸다(실제로 1.00375 가 나왔다).
  // 주기 4 의 +1,-1,-1,+1 은 Σe = 0, Σi·e = 0 이라 잔차로 그대로 남는다.
  const noise = [1, -1, -1, 1];
  const v = Array.from({ length: 40 }, (_, i) => i + noise[i % 4]);
  const f = linregFit(v);
  near(f.slope, 1, 1e-9);
  near(f.intercept, 0, 1e-9);
  near(f.sd, 1, 1e-9);      // Σe² = n → sqrt(n/n) = 1
});

test("linregFit — 표본이 모자라면 null", () => {
  assert.equal(linregFit([]), null);
  assert.equal(linregFit([5]), null);
  assert.equal(linregFit(null), null);
});

/* ── 피보나치 ── */

test("fibLevels — 상승 구간", () => {
  const r = fibLevels(100, 200, [0, 0.382, 0.5, 0.618, 1]);
  near(r[0].price, 100);
  near(r[1].price, 138.2);
  near(r[2].price, 150);
  near(r[3].price, 161.8);
  near(r[4].price, 200);
});

test("fibLevels — 하락 구간은 방향이 뒤집힌다", () => {
  const r = fibLevels(200, 100, [0, 0.5, 1]);
  near(r[0].price, 200);
  near(r[1].price, 150);
  near(r[2].price, 100);
});

test("fibLevels — 1 초과는 확장", () => {
  const r = fibLevels(100, 200, [1.272, 1.618]);
  near(r[0].price, 227.2, 1e-9);
  near(r[1].price, 261.8, 1e-9);
});

/* ── 자석 ── */

test("magnetPrice — 임계 안이면 OHLC 로 스냅", () => {
  const bar = { open: 100, high: 110, low: 90, close: 105 };
  const toY = (p) => 400 - p * 2;                 // 1가격 = 2px
  assert.equal(magnetPrice(104, bar, toY), 105);  // 2px 차이 → 붙는다
});

test("magnetPrice — 임계 밖이면 그대로", () => {
  const bar = { open: 100, high: 110, low: 90, close: 105 };
  const toY = (p) => 400 - p * 2;                  // 1가격 = 2px
  assert.equal(magnetPrice(60, bar, toY, 8), 60);  // 가장 가까운 low(90) 도 60px 밖
  assert.equal(magnetPrice(99, bar, toY, 1), 99);  // 임계를 좁히면 2px 도 밖
});

test("magnetPrice — 가장 가까운 값 하나만 고른다", () => {
  const bar = { open: 100, high: 110, low: 90, close: 101 };
  const toY = (p) => 400 - p * 4;
  assert.equal(magnetPrice(100.6, bar, toY, 8), 101);
  assert.equal(magnetPrice(100.4, bar, toY, 8), 100);
});

test("magnetPrice — 봉이 없으면 원래 가격", () => {
  assert.equal(magnetPrice(123, null, () => 0), 123);
});

/* ── 그 외 ── */

test("angleDeg — 화면 y 반전을 반영한다", () => {
  near(angleDeg(0, 0, 10, 0), 0);      // 오른쪽
  near(angleDeg(0, 0, 10, -10), 45);   // 오른쪽 위 (y 감소) → 양수
  near(angleDeg(0, 0, 10, 10), -45);   // 오른쪽 아래 → 음수
  near(angleDeg(0, 0, 0, -10), 90);    // 위
});

test("nearestAnchorIdx — 반경 안에서 가장 가까운 것", () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  assert.equal(nearestAnchorIdx(2, 2, pts, 7), 0);
  assert.equal(nearestAnchorIdx(98, 3, pts, 7), 1);
  assert.equal(nearestAnchorIdx(50, 50, pts, 7), -1);
});

test("nearestAnchorIdx — 좌표가 없는 앵커는 건너뛴다", () => {
  const pts = [{ x: null, y: null }, { x: 3, y: 3 }];
  assert.equal(nearestAnchorIdx(2, 2, pts, 7), 1);
});

test("bboxOf / inBox — 여백 포함", () => {
  const b = bboxOf([{ x: 10, y: 20 }, { x: 50, y: 5 }], 4);
  assert.deepEqual(b, { x1: 6, y1: 1, x2: 54, y2: 24 });
  assert.ok(inBox(10, 20, b));
  assert.ok(inBox(6, 1, b));
  assert.ok(!inBox(5, 20, b));
  assert.ok(!inBox(10, 30, b));
});

test("bboxOf — 유효한 점이 없으면 null, inBox 는 false", () => {
  assert.equal(bboxOf([]), null);
  assert.equal(bboxOf([{ x: null, y: null }]), null);
  assert.equal(inBox(0, 0, null), false);
});
