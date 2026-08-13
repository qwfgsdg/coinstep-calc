/* ═══════════════════════════════════════════
   차트 프리미티브 (직접 그리기)

   lightweight-charts 는 선·히스토그램·마커까지만 기본 제공한다.
   Pine 의 box.new / fill() / label 처럼 캔버스에 임의의 도형을 그리려면
   ISeriesPrimitive 를 구현해 series.attachPrimitive() 로 붙여야 한다.

   전부 같은 규약을 따른다.
     new XxxPrimitive(opts) → series.attachPrimitive(p) → p.setData(...) → p.detach()

   좌표계
     x  timeScale().logicalToCoordinate(봉 인덱스)
        시간 대신 인덱스를 쓰는 이유: 화면 밖이나 데이터 끝 너머(존을 오른쪽으로
        연장할 때)도 값이 나온다. timeToCoordinate 는 데이터에 없는 시각이면 null.
     y  series.priceToCoordinate(가격)
     둘 다 media(CSS) 픽셀이라 useMediaCoordinateSpace 안에서 그린다.
   ═══════════════════════════════════════════ */

class Primitive {
  constructor(zOrder = "bottom") {
    this._data = null;
    this._p = null;
    this._views = [{
      zOrder: () => zOrder,
      renderer: () => (this._data ? { draw: (t) => this._paint(t) } : null),
    }];
  }
  attached(p) { this._p = p; }
  detached() { this._p = null; this._data = null; }
  paneViews() { return this._views; }
  updateAllViews() { /* 렌더러가 매번 최신 데이터를 읽으므로 캐시할 것이 없다 */ }

  setData(d) {
    this._data = d && (Array.isArray(d) ? d.length : true) ? d : null;
    this._p?.requestUpdate();
  }
  detach() {
    const p = this._p;
    if (p) { try { p.series.detachPrimitive(this); } catch { /* 이미 떨어짐 */ } }
    this._p = null;
  }

  // 하위 클래스가 쓰는 좌표 변환기
  _xy() {
    const p = this._p;
    if (!p) return null;
    const ts = p.chart.timeScale();
    return {
      x: (i) => ts.logicalToCoordinate(i),
      y: (v) => p.series.priceToCoordinate(v),
    };
  }
  _paint() { /* 하위 클래스에서 구현 */ }
}

/* ── 두 선 사이 채우기 (Pine fill) ──────────────
   data: [{ i, upper, lower, color }]  — 봉마다 색이 달라도 된다 */
export class BandPrimitive extends Primitive {
  constructor() { super("bottom"); }

  _paint(target) {
    const rows = this._data, m = this._xy();
    if (!rows || !m) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.save();
      let s = 0;
      while (s < rows.length) {
        // 같은 색이 이어지는 구간을 한 덩어리로 칠한다
        let e = s;
        while (e + 1 < rows.length
          && rows[e + 1].color === rows[s].color
          && rows[e + 1].i === rows[e].i + 1) e++;
        // 색이 바뀌는 경계에서 틈이 보이지 않게 한 봉 겹친다
        const stop = e + 1 < rows.length && rows[e + 1].i === rows[e].i + 1 ? e + 1 : e;
        if (stop > s) {
          ctx.beginPath();
          let started = false;
          for (let k = s; k <= stop; k++) {
            const x = m.x(rows[k].i), y = m.y(rows[k].upper);
            if (x == null || y == null) continue;
            if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
          }
          for (let k = stop; k >= s; k--) {
            const x = m.x(rows[k].i), y = m.y(rows[k].lower);
            if (x == null || y == null) continue;
            ctx.lineTo(x, y);
          }
          if (started) { ctx.closePath(); ctx.fillStyle = rows[s].color; ctx.fill(); }
        }
        s = e + 1;
      }
      ctx.restore();
    });
  }
}

/* ── 박스 (Pine box.new) ────────────────────────
   data: [{ i1, i2, top, bottom, fill, border, dash, label, labelColor, labelAlign }]
   top === bottom 이면 선 하나로 그린다 (POI · BOS 중앙선) */
export class BoxesPrimitive extends Primitive {
  constructor() { super("bottom"); }

  _paint(target) {
    const boxes = this._data, m = this._xy();
    if (!boxes || !m) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = "10px 'DM Sans', sans-serif";
      ctx.textBaseline = "middle";
      for (const b of boxes) {
        let x1 = m.x(b.i1), x2 = m.x(b.i2);
        const y1 = m.y(b.top), y2 = m.y(b.bottom);
        if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
        // 화면 밖으로 한참 나간 좌표를 그대로 넘기면 캔버스가 느려진다
        x1 = Math.max(-2000, Math.min(mediaSize.width + 2000, x1));
        x2 = Math.max(-2000, Math.min(mediaSize.width + 2000, x2));
        if (x2 < x1) continue;
        const h = Math.abs(y2 - y1);

        if (h < 0.5) {
          ctx.beginPath();
          ctx.setLineDash(b.dash ? [3, 3] : []);
          ctx.strokeStyle = b.border || b.fill || "#888";
          ctx.lineWidth = 1;
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y1);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          if (b.fill) { ctx.fillStyle = b.fill; ctx.fillRect(x1, Math.min(y1, y2), x2 - x1, h); }
          if (b.border) {
            ctx.strokeStyle = b.border; ctx.lineWidth = 1;
            ctx.strokeRect(x1 + 0.5, Math.min(y1, y2) + 0.5, x2 - x1 - 1, h - 1);
          }
        }

        if (b.label) {
          ctx.fillStyle = b.labelColor || "#fff";
          const cy = (y1 + y2) / 2;
          // 화면에 걸쳐 있으면 보이는 쪽으로 글자를 끌어온다
          const vl = Math.max(x1, 0), vr = Math.min(x2, mediaSize.width);
          if (vr - vl > 24) {
            if (b.labelAlign === "left") { ctx.textAlign = "left"; ctx.fillText(b.label, vl + 4, cy); }
            else { ctx.textAlign = "center"; ctx.fillText(b.label, (vl + vr) / 2, cy); }
          }
        }
      }
      ctx.restore();
    });
  }
}

/* ── 볼륨 프로파일 가로 히스토그램 ───────────────
   data: { i0, i1, rows: [{ p0, p1, up, down, inVA }], maxVol, poc,
           upColor, downColor, vaUpColor, vaDownColor, pocColor, pocWidth } */
export class ProfilePrimitive extends Primitive {
  constructor() { super("bottom"); }

  _paint(target) {
    const d = this._data, m = this._xy();
    if (!d || !d.rows?.length || !(d.maxVol > 0)) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const x0 = m.x(d.i0), x1 = m.x(d.i1);
      if (x0 == null || x1 == null) return;
      // Pine 은 최대 막대를 구간 폭의 1/3 로 잡는다
      const span = Math.max(0, (x1 - x0) / 3);
      if (span <= 0) return;
      ctx.save();
      for (const r of d.rows) {
        const ya = m.y(r.p0), yb = m.y(r.p1);
        if (ya == null || yb == null) continue;
        const top = Math.min(ya, yb), h = Math.max(1, Math.abs(yb - ya) - 1);
        const wUp = (r.up / d.maxVol) * span;
        const wDn = (r.down / d.maxVol) * span;
        ctx.fillStyle = r.inVA ? d.vaUpColor : d.upColor;
        ctx.fillRect(x0, top, wUp, h);
        ctx.fillStyle = r.inVA ? d.vaDownColor : d.downColor;
        ctx.fillRect(x0 + wUp, top, wDn, h);
      }
      if (d.poc != null) {
        const yp = m.y(d.poc);
        if (yp != null) {
          ctx.beginPath();
          ctx.strokeStyle = d.pocColor || "#ff0000";
          ctx.lineWidth = d.pocWidth || 2;
          ctx.moveTo(x0, yp); ctx.lineTo(mediaSize.width, yp);
          ctx.stroke();
        }
      }
      ctx.restore();
    });
  }
}

/* ── 도형 마커 (라이브러리에 없는 다이아 등) ─────
   data: [{ i, price, color, size, shape, position }]
   position: "above" | "below" | "at" */
export class ShapesPrimitive extends Primitive {
  constructor() { super("top"); }

  _paint(target) {
    const rows = this._data, m = this._xy();
    if (!rows || !m) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      for (const s of rows) {
        const x = m.x(s.i), y0 = m.y(s.price);
        if (x == null || y0 == null) continue;
        if (x < -20 || x > mediaSize.width + 20) continue;
        const r = s.size || 4;
        const y = s.position === "above" ? y0 - r - 3 : s.position === "below" ? y0 + r + 3 : y0;
        ctx.beginPath();
        if (s.shape === "diamond") {
          ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
          ctx.closePath();
        } else {
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
        ctx.fillStyle = s.color || "#fff";
        ctx.fill();
        if (s.stroke) { ctx.strokeStyle = s.stroke; ctx.lineWidth = 1; ctx.stroke(); }
      }
      ctx.restore();
    });
  }
}

/* 출력 종류 → 프리미티브 클래스 */
export const PRIMITIVE_TYPES = {
  band: BandPrimitive,
  boxes: BoxesPrimitive,
  profile: ProfilePrimitive,
  shapes: ShapesPrimitive,
};
