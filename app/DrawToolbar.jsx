"use client";

/* ═══════════════════════════════════════════
   그리기 툴바 — 차트 왼쪽 세로 레일

   TradingView 배치를 따른다. 위쪽은 도구(커서 · 라인 그룹), 구분선 아래는
   전역 토글(자석 · 그리기 모드 유지 · 잠금 · 숨김 · 삭제).
   도구 목록은 ./drawings 레지스트리에서 그대로 나오므로, 도구를 추가할 때
   이 파일은 건드리지 않는다. 그룹만 GROUPS 에 늘리면 된다.

   그룹 버튼은 마지막에 쓴 도구를 바로 켜고, 오른쪽 아래 삼각형이 목록을 연다.
   ═══════════════════════════════════════════ */

import { useEffect, useRef, useState } from "react";
import { REGISTRY, GROUPS } from "./drawings";

const W = 34;                 // 레일 폭 — 범례를 밀어낼 때 이 값을 쓴다
export const TOOLBAR_W = W;

const ACTIVE = "#0ea5e9";

function ToolIcon({ def, size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ display: "block" }}>
      <path d={def.icon} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      {(def.dots || []).map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="1.9" fill="currentColor" />
      ))}
    </svg>
  );
}

const GLYPH = {
  cursor: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ display: "block" }}>
      <path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
    </svg>
  ),
};

function Btn({ on, dim, title, onClick, children, danger }) {
  const c = danger ? "#f87171" : on ? ACTIVE : "var(--text-muted)";
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        position: "relative",
        width: W - 6, height: W - 6,
        display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: 6, cursor: "pointer",
        border: `1px solid ${on ? ACTIVE + "55" : "transparent"}`,
        background: on ? ACTIVE + "18" : "transparent",
        color: c, opacity: dim ? 0.4 : 1,
        fontSize: 12, lineHeight: 1, padding: 0,
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}
    >
      {children}
    </button>
  );
}

/* 스타일 바의 입력 하나. 도구 정의의 params 항목을 그대로 받는다. */
function Param({ p, value, onChange }) {
  const v = value ?? p.def;
  const boxed = {
    background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 4,
    color: "var(--text-bright)", fontSize: 10, padding: "1px 3px", outline: "none",
  };
  if (p.type === "color") {
    return (
      <input type="color" title={p.label} value={String(v).slice(0, 7)}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 20, height: 18, padding: 0, border: "none", background: "none", cursor: "pointer" }} />
    );
  }
  if (p.type === "bool") {
    return (
      <button type="button" title={p.label} onClick={() => onChange(!v)}
        style={{
          background: "none", border: "1px solid var(--border)", borderRadius: 4,
          color: v ? ACTIVE : "var(--text-dim)", cursor: "pointer",
          padding: "1px 5px", fontSize: 9, lineHeight: 1.5, fontFamily: "'DM Sans'",
        }}>{p.label}</button>
    );
  }
  if (p.key === "width") {
    return (
      <select title={p.label} value={v} onChange={(e) => onChange(Number(e.target.value))} style={boxed}>
        {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}px</option>)}
      </select>
    );
  }
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <span style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "'DM Sans'" }}>{p.label}</span>
      <input type="number" title={p.label} value={v} min={p.min} max={p.max}
        step={p.type === "float" ? (p.step ?? 0.1) : 1}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "" || raw === "-") return;
          const n = Number(raw);
          if (!isFinite(n)) return;
          const q = p.type === "float" ? n : Math.round(n);
          onChange(Math.min(p.max ?? q, Math.max(p.min ?? q, q)));
        }}
        style={{ ...boxed, width: 42, fontFamily: "'IBM Plex Mono'" }} />
    </span>
  );
}

export default function DrawToolbar({
  tool, onTool, selectedDef,
  magnet, onMagnet,
  stay, onStay,
  locked, onLocked,
  hidden, onHidden,
  count, onClearAll,
  canUndo, onUndo,
  selected, onStyle, onDeleteSelected,
}) {
  const [openGroup, setOpenGroup] = useState(null);
  const [lastOf, setLastOf] = useState(() =>
    Object.fromEntries(GROUPS.map((g) => [g.id, REGISTRY.find((d) => d.group === g.id)?.id])));
  const boxRef = useRef(null);

  // 바깥을 누르면 목록을 닫는다
  useEffect(() => {
    if (!openGroup) return;
    const away = (e) => { if (!boxRef.current?.contains(e.target)) setOpenGroup(null); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [openGroup]);

  const pick = (id) => {
    const def = REGISTRY.find((d) => d.id === id);
    if (def) setLastOf((m) => ({ ...m, [def.group]: id }));
    onTool(id);
    setOpenGroup(null);
  };

  return (
    <div ref={boxRef} style={{
      position: "absolute", top: 0, left: 0, zIndex: 6,
      width: W, display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
      // 그룹이 늘어 레일이 길어졌다. 차트가 짧거나 보조 창을 여러 개 켜면
      // 카드 밖으로 나가므로 넘치면 레일 안에서 굴린다.
      maxHeight: "100%", overflowY: "auto", overflowX: "visible",
      padding: "3px 0", borderRadius: 8,
      background: "var(--bg-card)", border: "1px solid var(--border)",
      boxShadow: "0 4px 14px #0006",
    }}>
      <Btn on={!tool} title="커서 (Esc)" onClick={() => onTool(null)}>{GLYPH.cursor}</Btn>

      {GROUPS.map((g) => {
        const items = REGISTRY.filter((d) => d.group === g.id);
        const cur = REGISTRY.find((d) => d.id === (lastOf[g.id] || items[0]?.id)) || items[0];
        const on = items.some((d) => d.id === tool);
        if (!cur) return null;
        return (
          <div key={g.id} style={{ position: "relative" }}>
            <Btn on={on} dim={locked} title={`${cur.name}${cur.shortcut ? ` (${cur.shortcut.replace("alt+", "Alt + ").toUpperCase()})` : ""}`}
              onClick={() => (locked ? null : pick(cur.id))}>
              <ToolIcon def={on ? (REGISTRY.find((d) => d.id === tool) || cur) : cur} />
            </Btn>
            {/* 목록 열기. 삼각형만 8px 로 그리되 누를 수 있는 면적은 14px 로 넓힌다 —
                8px 는 마우스로도 잘 안 잡히고 자동화 도구는 아예 가려진 것으로 본다. */}
            <span
              role="button"
              title={`${g.name} 도구 목록`}
              onClick={(e) => { e.stopPropagation(); setOpenGroup((v) => (v === g.id ? null : g.id)); }}
              style={{
                position: "absolute", right: 0, bottom: 0, width: 14, height: 14,
                display: "flex", alignItems: "flex-end", justifyContent: "flex-end",
                padding: 2, cursor: "pointer", lineHeight: 0,
              }}>
              <svg width="8" height="8" viewBox="0 0 8 8" style={{ display: "block" }}>
                <path d="M8 8H2L8 2z" fill={on ? ACTIVE : "var(--text-dim)"} />
              </svg>
            </span>

            {openGroup === g.id && (
              <div style={{
                position: "absolute", left: W - 2, top: -3, zIndex: 30, width: 190,
                background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
                boxShadow: "0 8px 24px #0009", padding: 5,
              }}>
                <div style={{ fontSize: 9, color: "var(--text-dim)", padding: "3px 6px", letterSpacing: 1 }}>{g.name}</div>
                {items.map((d) => (
                  <div key={d.id} onClick={() => pick(d.id)} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "5px 6px", borderRadius: 5, cursor: "pointer",
                    fontSize: 11, fontFamily: "'DM Sans'",
                    color: d.id === tool ? ACTIVE : "var(--text-secondary)",
                    background: d.id === tool ? ACTIVE + "15" : "transparent",
                  }}
                    onMouseEnter={(e) => { if (d.id !== tool) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { if (d.id !== tool) e.currentTarget.style.background = "transparent"; }}>
                    <span style={{ color: "inherit", flexShrink: 0 }}><ToolIcon def={d} /></span>
                    <span style={{ flex: 1 }}>{d.name}</span>
                    {d.shortcut && (
                      <span style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "'IBM Plex Mono'" }}>
                        {d.shortcut.replace("alt+", "Alt+").toUpperCase()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ width: W - 12, height: 1, background: "var(--border)", margin: "3px 0" }} />

      <Btn on={magnet} title={magnet ? "자석 켜짐 — 앵커가 봉의 시·고·저·종가에 붙는다" : "자석"}
        onClick={() => onMagnet(!magnet)}>🧲</Btn>
      <Btn on={stay} title={stay ? "그리기 모드 유지 — 계속 같은 도구로 그린다" : "그리기 모드 유지"}
        onClick={() => onStay(!stay)}>✎</Btn>
      <Btn on={locked} title={locked ? "잠금 — 그림을 고를 수 없다" : "모든 그림 잠금"}
        onClick={() => onLocked(!locked)}>{locked ? "🔒" : "🔓"}</Btn>
      <Btn on={hidden} title={hidden ? "숨김 — 그림이 보이지 않는다" : "모든 그림 숨김"}
        onClick={() => onHidden(!hidden)}>{hidden ? "🙈" : "👁"}</Btn>
      <Btn dim={!canUndo} title="실행 취소 (Ctrl + Z)" onClick={() => canUndo && onUndo()}>↩</Btn>
      <Btn dim={count === 0} danger title={count ? `그림 ${count}개 전체 삭제` : "삭제할 그림이 없다"}
        onClick={() => count && onClearAll()}>🗑</Btn>
      {count > 0 && (
        <span style={{ fontSize: 8, color: "var(--text-dim)", fontFamily: "'IBM Plex Mono'", marginTop: -2 }}>{count}</span>
      )}

      {/* 선택한 그림의 스타일 — TradingView 의 떠 있는 서식 막대.
          입력은 도구 정의의 params 에서 그대로 만들어진다. 회귀 추세의 편차나
          피보나치의 우연장처럼 도구마다 다른 값도 여기 코드를 고치지 않고 뜬다. */}
      {selected && selectedDef && !locked && (
        <div style={{
          position: "absolute", left: W + 6, top: 0, zIndex: 25,
          display: "flex", alignItems: "center", gap: 5, padding: "4px 7px",
          background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 7,
          boxShadow: "0 6px 18px #0008", whiteSpace: "nowrap",
        }}>
          <span style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "'DM Sans'", marginRight: 1 }}>
            {selectedDef.name}
          </span>
          {selectedDef.params.map((p) => (
            <Param key={p.key} p={p} value={selected.style?.[p.key]} onChange={(v) => onStyle(p.key, v)} />
          ))}
          <button type="button" title="삭제 (Delete)" onClick={onDeleteSelected}
            style={{
              background: "none", border: "none", color: "#f87171",
              cursor: "pointer", padding: "0 2px", fontSize: 11, lineHeight: 1,
            }}>✕</button>
        </div>
      )}
    </div>
  );
}
