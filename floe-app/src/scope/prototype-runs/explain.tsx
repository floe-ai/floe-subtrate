import React from "react";

/**
 * PROTOTYPE — throwaway "is this real?" toggle.
 *
 * The operator asked the sharpest question of revision 3: which of what I am
 * looking at is the product, and which is you arguing the model at me?
 *
 * Fair. The prototype had grown explanatory prose inside the UI — sentences
 * like "there is no second node and no arrow pointing backwards". Those are a
 * debating device, not a feature, and leaving them in makes the surface
 * impossible to judge.
 *
 * So they are all gated behind this flag. Explain OFF is the honest product
 * surface: states, counts, badges, the return edge, the caller link — data,
 * with no commentary. Explain ON is the annotated tour.
 *
 * Nothing else is gated. If it survives with explain off, it is a real claim
 * about the product.
 */

function initial(): boolean {
  if (typeof window === "undefined") return true;
  return new URLSearchParams(window.location.search).get("explain") !== "0";
}

let explain = initial();
const listeners = new Set<(v: boolean) => void>();

export function getExplain(): boolean {
  return explain;
}

export function setExplain(next: boolean): void {
  explain = next;
  if (typeof window !== "undefined") {
    const url = new URL(window.location.href);
    if (next) url.searchParams.delete("explain");
    else url.searchParams.set("explain", "0");
    window.history.replaceState({}, "", url.toString());
  }
  for (const l of listeners) l(explain);
}

export function subscribeExplain(fn: (v: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useExplain(): boolean {
  const [v, setV] = React.useState(getExplain);
  React.useEffect(() => subscribeExplain(setV), []);
  return v;
}

