/**
 * PROTOTYPE — throwaway floating variant switcher.
 *
 * Deliberately ugly and high-contrast so nobody mistakes it for the design
 * being judged. Hidden in production builds.
 */
import React, { useEffect } from "react";

export type VariantDef = { key: string; name: string };

export function PrototypeSwitcher({
  variants, current, onChange,
}: {
  variants: VariantDef[];
  current: string;
  onChange: (key: string) => void;
}): React.ReactElement | null {
  const idx = Math.max(0, variants.findIndex(v => v.key === current));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") onChange(variants[(idx - 1 + variants.length) % variants.length].key);
      if (e.key === "ArrowRight") onChange(variants[(idx + 1) % variants.length].key);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, variants, onChange]);

  if (import.meta.env?.PROD) return null;

  const btn: React.CSSProperties = {
    background: "transparent", border: "none", color: "#111", cursor: "pointer",
    fontSize: 15, lineHeight: 1, padding: "0 8px", fontWeight: 700,
  };

  return (
    <div style={{
      position: "fixed", left: "50%", bottom: 18, transform: "translateX(-50%)",
      zIndex: 9999, display: "flex", alignItems: "center",
      background: "#f7f8f8", color: "#111", borderRadius: 999,
      padding: "7px 10px", boxShadow: "0 8px 30px rgba(0,0,0,0.55)",
      fontFamily: '"Inter Variable","Inter",system-ui,sans-serif', fontSize: 12,
      userSelect: "none",
    }}>
      <button onClick={() => onChange(variants[(idx - 1 + variants.length) % variants.length].key)} style={btn}>‹</button>
      <span style={{ padding: "0 6px", whiteSpace: "nowrap", fontWeight: 600 }}>
        PROTOTYPE {variants[idx].key} — {variants[idx].name}
      </span>
      <button onClick={() => onChange(variants[(idx + 1) % variants.length].key)} style={btn}>›</button>
      <span style={{ paddingLeft: 8, color: "#666", fontSize: 10.5, whiteSpace: "nowrap" }}>
        ← → to cycle
      </span>
    </div>
  );
}
