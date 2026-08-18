"use client";

/* ═══════════════════════════════════════════
   그리기 레이어 — 프리미티브 + 포인터 상태머신

   3층 중 2·3층. 좌표 수학은 전부 ./drawing-geom.mjs (순수·테스트됨) 에 있고
   여기는 "언제 무엇을 그리고 무엇을 잡는가" 만 다룬다.

   ── 검증해서 알아낸 라이브러리 사실들 (lightweight-charts 5.2)
   1. 프리미티브는 series.attachPrimitive 로만 캔들 위에 온다. pane.attachPrimitive
      는 zOrder 와 무관하게 항상 series 보다 먼저 그려진다 (소스 9932~9945).
   2. setData 는 프리미티브를 지우지 않는다. 30초 로더가 그림을 날리지 않는다.
   3. hitTest 는 hover 뿐 아니라 드래그 중에도 매 mousemove 마다 호출된다.
      그래서 좌표를 다시 계산하지 않고 마지막 paint 의 캐시만 읽는다.
   4. requestUpdate() 는 model.fullUpdate() — 전체 재렌더다. rAF 로 합친다.
   5. 라이브러리 리스너는 전부 bubble 이라 capture 로 가로챌 수 있다.
      handleScroll/handleScale 은 이벤트마다 다시 읽으므로 드래그 중 토글이 먹는다.

   ── 상태
   IDLE ─(도구 선택)→ ARMED ─(누름)→ PLACING ─(뗌)→ IDLE
   IDLE ─(그림 위 누름)→ DRAG_ANCHOR | DRAG_BODY ─(뗌)→ IDLE
   boolean 여러 개로 쪼개면 불법 조합이 생긴다. 단일 문자열로만 둔다.

   ── 불변식
   1. 저장되는 time 은 캔들과 같은 축 (이미 +9h).
   2. _prims.size === _list.length
   3. _blocking() ⇔ handleScroll/handleScale 이 꺼져 있다
   4. logicalToCoordinate / coordinateToLogical 직접 호출 금지 — mapper() 경유
   ═══════════════════════════════════════════ */

import {
  timeToLogical, logicalToTime, subBarX, logicalOfX,
  nearestAnchorIdx, inBox, magnetPrice, barSecOf,
} from "./drawing-geom.mjs";
import { KINDS, byId, defaultStyle, needsInfo } from "./drawings";

const HIT_PAD = 6;      // 선을 잡을 수 있는 여유 (px)
const ANCHOR_HIT = 9;   // 핸들 히트 반경 — 선보다 넓어야 끝점을 잡을 수 있다
const DRAG_MIN = 3;     // 이보다 짧으면 그릴 의도가 아니라 클릭으로 본다

let seq = 0;
export const nextDid = () => `d${Date.now().toString(36)}${++seq}`;

/* 정보 라인이 쓰는 경과 시간 표기 */
function humanSpan(sec) {
  const s = Math.abs(Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}일 ${h}시간` : `${d}일`;
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  return `${m}분`;
}

/* ── 프리미티브 ─────────────────────────────
   그림 1개 = 프리미티브 1개. hitTest 와 zOrder 가 프리미티브 단위라
   하나로 합치면 "겹친 것 중 무엇을 잡을지" 를 직접 짜야 한다. */

class DrawingPrimitive {
  constructor(id, host) {
    this._id = id;
    this._host = host;
    this._p = null;
    this._pts = [];     // 마지막 paint 의 앵커 화면 좌표 — hitTest 와 드래그가 읽는다
    this._shape = null; // 그 프레임에 계산한 선분·다각형 — hitTest 가 이것만 본다
    this._box = null;
    this._views = [{
      zOrder: () => "top",
      renderer: () => ({ draw: (t) => this._paint(t) }),
    }];
  }

  attached(p) { this._p = p; }
  detached() { this._p = null; this._clear(); }
  _clear() { this._pts = []; this._shape = null; this._box = null; }
  paneViews() { return this._views; }
  updateAllViews() { /* 렌더러가 매번 최신 상태를 읽으므로 캐시할 것이 없다 */ }

  /* 그리기는 가격 스케일을 건드리면 안 된다. 피보나치를 현재가의 3배에
     놓으면 캔들이 한 줄로 눌린다. 기존 spec 선의 SCALE_MIN/MAX 가드와 같은 이유. */
  autoscaleInfo() { return null; }

  requestUpdate() { try { this._p?.requestUpdate(); } catch { /* 이미 떨어짐 */ } }
  coords() { return this._pts; }

  detach() {
    const p = this._p;
    if (p) { try { p.series.detachPrimitive(this); } catch { /* 이미 떨어짐 */ } }
    this._p = null;
  }

  _paint(target) {
    const st = this._host.stateOf(this._id);
    const def = st && byId(st.d.tool);
    const kind = def && KINDS[def.kind];
    if (!st || !kind || st.hiddenAll || st.d.hidden) { this._clear(); return; }

    const m = this._host.mapper();
    if (!m) { this._clear(); return; }

    const candles = this._host.candles();
    const barSec = this._host.barSec();
    const anchors = st.d.points;
    const logicals = anchors.map((a) => timeToLogical(a.time, candles, barSec));
    const pts = anchors.map((a, i) => ({
      x: logicals[i] == null ? null : m.x(logicals[i]),
      y: m.y(a.price),
    }));

    // 정보 라인·측정자가 쓰는 값. 앵커(time·price)를 아는 곳은 여기뿐이다.
    let info = null;
    if (needsInfo(def) && anchors.length >= 2) {
      const [p0, p1] = anchors;
      info = {
        dPrice: p1.price - p0.price,
        dPct: p0.price ? (p1.price / p0.price - 1) * 100 : 0,
        dBars: (logicals[1] ?? 0) - (logicals[0] ?? 0),
        span: humanSpan(p1.time - p0.time),
      };
    }

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const env = {
        pts, anchors, def, info, logicals, candles, map: m,
        w: mediaSize.width, h: mediaSize.height,
        style: st.d.style,
        selected: st.selected,
        hovered: st.hovered,
      };
      const shape = kind.shape(env);
      this._pts = pts;
      this._shape = shape;
      this._box = kind.box(shape, pts, Math.max(HIT_PAD, ANCHOR_HIT));
      ctx.save();
      kind.draw(ctx, env, shape);
      ctx.restore();
    });
  }

  /* 매 mousemove 마다 호출된다. 좌표를 다시 계산하지 않고 캐시와
     바운딩 박스 선검사로 끝낸다. */
  hitTest(x, y) {
    const st = this._host.stateOf(this._id);
    if (!st || st.hiddenAll || st.d.hidden || st.locked) return null;
    const def = byId(st.d.tool);
    const kind = def && KINDS[def.kind];
    if (!kind || !this._shape || !inBox(x, y, this._box)) return null;

    // 핸들은 선택된 그림에서만 잡힌다 (TradingView 와 같다)
    if (st.selected) {
      const ai = nearestAnchorIdx(x, y, this._pts, ANCHOR_HIT);
      if (ai >= 0) {
        return { externalId: `${this._id}:a${ai}`, cursorStyle: "grab", hitTestPriority: 2, distance: 0 };
      }
    }
    const r = kind.hit(x, y, { pts: this._pts, def }, this._shape);
    // 우선순위 규약: 면 0 · 선 1 · 핸들 2 (라이브러리 PrimitiveHoveredItem 권장값).
    // 면은 거리가 0 이라 여유 검사를 건너뛴다 — 안쪽이면 이미 안쪽이다.
    if (!r || (r.priority > 0 && r.d > HIT_PAD)) return null;
    return {
      externalId: `${this._id}:body`, cursorStyle: "move",
      hitTestPriority: r.priority, distance: r.d,
    };
  }
}

/* ── 컨트롤러 ───────────────────────────────
   포인터 이벤트를 capture 로 가로채 상태머신을 돌리고, 커밋 시점에만
   React 로 올려보낸다. 드래그 중에는 React 를 거치지 않는다 —
   프레임마다 setState 하면 전체 트리가 다시 그려진다. */

export class DrawingController {
  constructor({ chart, series, root, getCandles, onCommit, onSelect, onToolDone }) {
    this._chart = chart;
    this._series = series;
    this._root = root;
    this._getCandles = getCandles;
    this._onCommit = onCommit;
    this._onSelect = onSelect;
    this._onToolDone = onToolDone;

    this._mode = "IDLE";
    this._tool = null;
    this._list = [];
    this._prims = new Map();
    this._selected = null;
    this._hovered = null;
    this._magnet = false;
    this._locked = false;
    this._allHidden = false;
    this._drag = null;
    this._draftId = null;
    this._raf = 0;
    this._disposed = false;

    this._down = (e) => this._onDown(e);
    this._move = (e) => this._onMove(e);
    this._up = (e) => this._onUp(e);
    this._blockMouse = (e) => { if (this._blocking()) { e.stopPropagation(); e.preventDefault(); } };
    this._onCrosshair = (param) => this._trackHover(param);

    root.addEventListener("pointerdown", this._down, { capture: true });
    root.addEventListener("pointermove", this._move, { capture: true, passive: false });
    root.addEventListener("pointerup", this._up, { capture: true });
    root.addEventListener("pointercancel", this._up, { capture: true });
    // pointerdown 이 먼저 돌아 모드를 세운 뒤라, 여기서 라이브러리 mousedown 을 끊으면
    // 스크롤 자체가 시작되지 않는다. handleScroll 토글과 이중으로 막는다.
    root.addEventListener("mousedown", this._blockMouse, { capture: true });
    try { chart.subscribeCrosshairMove(this._onCrosshair); } catch { /* 무시 */ }
  }

  /* ── 외부(React) → 컨트롤러 ── */

  setTool(tool) {
    this._tool = tool || null;
    if (this._mode === "PLACING") this.cancel();
    this._setMode(this._tool ? "ARMED" : "IDLE");
  }

  setDrawings(list) {
    this._list = Array.isArray(list) ? list : [];
    const want = new Set(this._list.map((d) => d.id));
    [...this._prims.keys()].forEach((id) => { if (!want.has(id)) this._detach(id); });
    this._list.forEach((d) => { if (!this._prims.has(d.id)) this._attach(d.id); });
    this._requestUpdate();
  }

  setSelected(id) { this._selected = id || null; this._requestUpdate(); }
  setMagnet(on) { this._magnet = !!on; }
  setLocked(on) { this._locked = !!on; if (on) this.cancel(); }
  setAllHidden(on) { this._allHidden = !!on; this._requestUpdate(); }

  cancel() {
    if (this._mode === "PLACING" && this._draftId) {
      this._detach(this._draftId);
      this._list = this._list.filter((x) => x.id !== this._draftId);
      this._draftId = null;
    }
    this._drag = null;
    this._setMode(this._tool ? "ARMED" : "IDLE");
    this._requestUpdate();
  }

  destroy() {
    this._disposed = true;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    const root = this._root;
    if (root) {
      root.removeEventListener("pointerdown", this._down, { capture: true });
      root.removeEventListener("pointermove", this._move, { capture: true });
      root.removeEventListener("pointerup", this._up, { capture: true });
      root.removeEventListener("pointercancel", this._up, { capture: true });
      root.removeEventListener("mousedown", this._blockMouse, { capture: true });
    }
    try { this._chart.unsubscribeCrosshairMove(this._onCrosshair); } catch { /* 무시 */ }
    [...this._prims.keys()].forEach((id) => this._detach(id));
    this._root = null;
  }

  /* ── 프리미티브가 읽는 상태 ── */

  stateOf(id) {
    const d = this._byId(id);
    if (!d) return null;
    return {
      d,
      selected: this._selected === id,
      hovered: this._hovered === id,
      locked: this._locked,
      hiddenAll: this._allHidden,
    };
  }
  candles() { return this._getCandles() || []; }
  barSec() {
    const c = this.candles();
    if (this._barSecKey !== c) { this._barSecKey = c; this._barSecVal = barSecOf(c); }
    return this._barSecVal;
  }

  /* 좌표 변환 — 불변식 4. 라이브러리 변환기를 직접 쓰지 않는 이유는
     drawing-geom 의 subBarX / logicalOfX 주석에 적어 뒀다. */
  mapper() {
    const ch = this._chart, se = this._series;
    if (!ch || !se || this._disposed) return null;
    let ts, bs, x0;
    try {
      ts = ch.timeScale();
      bs = ts.options().barSpacing;
      x0 = ts.logicalToCoordinate(0);
    } catch { return null; }
    if (x0 == null || !(bs > 0)) return null;
    return {
      x: (L) => {
        const f = Math.floor(L);
        const c = ts.logicalToCoordinate(f);
        return c == null ? null : subBarX(c, L - f, bs);
      },
      logicalOf: (x) => logicalOfX(x, x0, bs),
      y: (p) => { try { return se.priceToCoordinate(p); } catch { return null; } },
      price: (y) => { try { return se.coordinateToPrice(y); } catch { return null; } },
    };
  }

  /* ── 내부 ── */

  _byId(id) { return this._list.find((x) => x.id === id) || null; }
  _blocking() {
    return this._mode === "PLACING" || this._mode === "DRAG_ANCHOR" || this._mode === "DRAG_BODY";
  }

  _setMode(next) {
    if (this._mode === next) return;
    const was = this._blocking();
    this._mode = next;
    const now = this._blocking();
    if (was !== now) {
      // 불변식 3. 안 끄면 도형을 끄는 동안 차트가 같이 밀린다.
      try { this._chart.applyOptions({ handleScroll: !now, handleScale: !now }); } catch { /* 무시 */ }
    }
  }

  _attach(id) {
    const p = new DrawingPrimitive(id, this);
    try { this._series.attachPrimitive(p); } catch { return; }
    this._prims.set(id, p);
  }
  _detach(id) {
    const p = this._prims.get(id);
    if (!p) return;
    p.detach();
    this._prims.delete(id);
  }

  /* requestUpdate 는 전체 재렌더라 프레임당 한 번으로 합친다.
     아무 프리미티브 하나만 불러도 차트 전체가 다시 그려진다. */
  _requestUpdate() {
    if (this._raf || this._disposed) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      const first = this._prims.values().next().value;
      first?.requestUpdate();
    });
  }

  _commit() { this._onCommit?.(this._list.slice()); }
  _emitSelect(id) { this._selected = id; this._onSelect?.(id); this._requestUpdate(); }

  /* 화면 좌표 → 가격 창 로컬 좌표.
     가격축·시간축·보조창에서 시작한 조작은 차트에 그대로 넘긴다.
     (기존 휠 핸들러가 쓰는 것과 같은 계산이다) */
  _local(e, loose = false) {
    const root = this._root;
    if (!root) return null;
    const rb = root.getBoundingClientRect();
    const x = e.clientX - rb.left;
    const y = e.clientY - rb.top;
    if (loose) return { x, y };
    let psW = 0, p0h = rb.height;
    try {
      psW = this._chart.priceScale("right").width();
      const ts = this._chart.timeScale();
      const tsH = typeof ts.height === "function" ? ts.height() : 0;
      const p0 = this._chart.panes()[0];
      p0h = p0 && typeof p0.getHeight === "function" ? p0.getHeight() : rb.height - tsH;
    } catch { return null; }
    if (x < 0 || x > rb.width - psW) return null;
    if (y < 0 || y > p0h) return null;
    return { x, y };
  }

  _barAt(L) {
    const c = this.candles();
    if (c.length === 0) return null;
    return c[Math.max(0, Math.min(c.length - 1, Math.round(L)))];
  }

  /* 화면 좌표 → 앵커 {time, price}. 저장은 항상 time 이다 (불변식 1). */
  _anchorAt(x, y, snap = true) {
    const m = this.mapper();
    if (!m) return null;
    const L = m.logicalOf(x);
    const price = m.price(y);
    if (L == null || price == null || !isFinite(L) || !isFinite(price)) return null;
    const time = logicalToTime(L, this.candles(), this.barSec());
    if (time == null) return null;
    const p = snap && this._magnet ? magnetPrice(price, this._barAt(L), m.y) : price;
    return { time, price: p };
  }

  /* 캐시된 좌표로 직접 판정한다. 라이브러리 hover 결과는 직전 mousemove
     기준이라 터치에서는 pointerdown 시점에 아직 없다. */
  _hitAt(x, y) {
    let best = null;
    this._prims.forEach((p, id) => {
      const h = p.hitTest(x, y);
      if (!h) return;
      const pr = h.hitTestPriority ?? 0;
      const d = h.distance ?? 0;
      if (!best || pr > best.pr || (pr === best.pr && d < best.d)) {
        best = { id, pr, d, part: String(h.externalId).split(":")[1] || "body" };
      }
    });
    return best;
  }

  _trackHover(param) {
    if (this._blocking()) return;
    const raw = param?.hoveredInfo?.objectId ?? param?.hoveredObjectId;
    const id = typeof raw === "string" ? raw.split(":")[0] : null;
    if (id === this._hovered) return;
    this._hovered = this._prims.has(id) ? id : null;
    this._requestUpdate();
  }

  /* ── 포인터 ── */

  _onDown(e) {
    if (this._disposed || e.button !== 0) return;
    const pt = this._local(e);
    if (!pt) return;

    if (this._tool && !this._locked) {
      const def = byId(this._tool);
      const a = def && this._anchorAt(pt.x, pt.y);
      if (!a) return;
      // 1점 도구(수평선·수직선·크로스라인)도 PLACING 을 거친다. 누르고 있는 동안
      // 위치를 다듬을 수 있고, 놓을 때 길이 검사만 건너뛰면 되므로 경로가 하나로 유지된다.
      const d = {
        id: nextDid(), tool: this._tool,
        points: def.points === 1 ? [a] : [a, { ...a }],
        style: defaultStyle(def),
      };
      this._list = [...this._list, d];
      this._draftId = d.id;
      this._attach(d.id);
      this._setMode("PLACING");
      this._grab(e);
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (this._locked) return;

    const hit = this._hitAt(pt.x, pt.y);
    if (!hit) {
      if (this._selected) this._emitSelect(null);   // 빈 곳 → 선택 해제하고 차트 팬은 그대로
      return;
    }
    // 드래그 대상만 복사본으로 갈아 끼운다. React 가 준 객체를 직접 바꾸면 안 된다.
    this._list = this._list.map((x) =>
      x.id === hit.id ? { ...x, points: x.points.map((p) => ({ ...p })) } : x);
    const prim = this._prims.get(hit.id);
    const ai = hit.part.startsWith("a") ? Number(hit.part.slice(1)) : -1;
    this._drag = {
      id: hit.id, anchor: ai, x0: pt.x, y0: pt.y,
      origXY: (prim?.coords() || []).map((p) => (p ? { ...p } : null)),
    };
    this._emitSelect(hit.id);
    this._setMode(ai >= 0 ? "DRAG_ANCHOR" : "DRAG_BODY");
    this._grab(e);
    e.preventDefault(); e.stopPropagation();
  }

  _onMove(e) {
    if (!this._blocking()) return;
    const pt = this._local(e, true);
    if (!pt) return;
    e.preventDefault(); e.stopPropagation();
    if (this._mode === "PLACING") {
      const d = this._byId(this._draftId);
      const a = d && this._anchorAt(pt.x, pt.y);
      // 커밋 전 초안이라 직접 변형해도 안전하다. 1점 도구는 그 점이 곧 마지막 점이다.
      if (a) d.points[d.points.length - 1] = a;
    } else if (this._drag) {
      const d = this._byId(this._drag.id);
      if (d) {
        const dx = pt.x - this._drag.x0, dy = pt.y - this._drag.y0;
        // 통째로 옮길 때 자석을 켜면 앵커마다 따로 붙어 모양이 일그러진다
        const snap = this._mode === "DRAG_ANCHOR";
        const at = (i) => {
          const s = this._drag.origXY[i];
          if (!s || s.x == null || s.y == null) return null;
          return this._anchorAt(s.x + dx, s.y + dy, snap);
        };
        if (this._drag.anchor >= 0) {
          const a = at(this._drag.anchor);
          if (a) d.points[this._drag.anchor] = a;
        } else {
          for (let i = 0; i < d.points.length; i++) {
            const a = at(i);
            if (a) d.points[i] = a;
          }
        }
      }
    }
    this._requestUpdate();
  }

  _onUp(e) {
    if (!this._blocking()) return;
    e.preventDefault(); e.stopPropagation();
    const placing = this._mode === "PLACING";
    let drew = false;

    if (placing) {
      const d = this._byId(this._draftId);
      if (d && this._longEnough(d)) {
        this._derive(d);
        drew = true;
        this._selected = d.id;
      } else {
        this._detach(this._draftId);
        this._list = this._list.filter((x) => x.id !== this._draftId);
      }
      this._draftId = null;
    }
    this._drag = null;
    this._setMode(this._tool && !drew ? "ARMED" : "IDLE");
    this._release(e);
    this._commit();
    if (drew) {
      this._onSelect?.(this._selected);
      this._onToolDone?.();     // 한 번 그리면 커서로 돌아간다 (그리기 모드 유지는 단계 E)
    }
    this._requestUpdate();
  }

  /* 앵커가 3~4개인 도구(채널·피보나치 확장·롱숏 포지션)는 2점 드래그로 만든 뒤
     나머지를 여기서 채운다. 세 번 클릭시키는 것보다 손이 덜 가고, 만들어진 다음
     핸들로 다듬는 흐름이 TradingView 와 같다. */
  _derive(d) {
    const def = byId(d.tool);
    if (!def?.derive) return;
    const m = this.mapper();
    const api = {
      // 화면 픽셀 만큼 떨어진 가격. 가격 폭이 아니라 화면 거리로 잡아야
      // 코인 가격대에 상관없이 같은 두께로 시작한다.
      offsetPrice: (price, dy) => {
        const y = m?.y(price);
        if (y == null) return price;
        const p = m.price(y + dy);
        return p == null || !isFinite(p) ? price : p;
      },
    };
    try {
      const next = def.derive(d.points, api);
      if (Array.isArray(next) && next.length >= d.points.length) d.points = next;
    } catch { /* 파생 실패시 원래 앵커로 둔다 */ }
  }

  /* 화면상 길이가 너무 짧으면 그릴 의도가 아니라 클릭이다.
     1점 도구는 클릭 한 번이 곧 완성이라 검사하지 않는다. */
  _longEnough(d) {
    if (d.points.length < 2) return true;
    const m = this.mapper();
    if (!m) return false;
    const c = this.candles(), b = this.barSec();
    const xy = d.points.map((a) => {
      const L = timeToLogical(a.time, c, b);
      return { x: L == null ? null : m.x(L), y: m.y(a.price) };
    });
    const [p, q] = xy;
    if (!p || !q || p.x == null || q.x == null || p.y == null || q.y == null) return false;
    return Math.hypot(q.x - p.x, q.y - p.y) >= DRAG_MIN;
  }

  /* 포인터 캡처 — 창 밖으로 나가도 pointerup 이 온다.
     안 하면 마우스를 밖에서 떼었을 때 드래그가 영원히 안 끝난다. */
  _grab(e) {
    try { this._root?.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
  }
  _release(e) {
    try { this._root?.releasePointerCapture(e.pointerId); } catch { /* 무시 */ }
  }
}
