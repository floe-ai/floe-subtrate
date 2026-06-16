/**
 * theme.ts — design tokens for floe-app.
 *
 * Calm, legible, WCAG AA. Visible focus rings. Status via label+shape not
 * color alone. Respects prefers-reduced-motion.
 */

export const colors = {
  canvas:      "#FAFAF8",
  surface:     "#FFFFFF",
  border:      "#E2E2DD",
  text:        "#1A1A1A",
  muted:       "#5A5F66",
  accent:      "#2D6BD8",
  accentText:  "#FFFFFF",
  bubbleOwn:   "#E7F0FF",
  bubbleOther: "#F2F4F7",
  danger:      "#B23A48",
} as const;

/** Spacing scale in px — use as margin/padding values */
export const space = {
  xs:  4,
  sm:  8,
  md:  12,
  lg:  16,
  xl:  24,
} as const;

export const font = {
  body: "14px/1.5 system-ui, sans-serif",
  meta: "12px",
  h:    600,
} as const;

/** Shared focus-ring style — apply to any interactive element */
export const focusRing: React.CSSProperties = {
  outline: `2px solid ${colors.accent}`,
  outlineOffset: 2,
};

// Make React available for the type reference above — callers import the module.
import type React from "react";
