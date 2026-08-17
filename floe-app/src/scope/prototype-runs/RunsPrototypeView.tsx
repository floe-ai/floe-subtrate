/**
 * PROTOTYPE HOST — throwaway. Mounted as a tab inside the real ScopeDetail so
 * the variants are judged against the real header, nav and density, not in a
 * vacuum.
 *
 * Three variants of "a node with fifty runs behind it", switchable via
 * ?variant=A|B|C on the existing scope route, or the floating bottom bar.
 *
 * Question under test (#184): does "a node is the work, a context is one run of
 * it" survive contact with fifty conversations behind three boxes?
 *
 * DELETE THIS DIRECTORY once the ticket is resolved.
 */
import React, { useState } from "react";
import { PrototypeSwitcher, type VariantDef } from "./PrototypeSwitcher.tsx";
import { VariantA, VARIANT_A_NAME } from "./VariantA.tsx";
import { VariantB, VARIANT_B_NAME } from "./VariantB.tsx";
import { VariantC, VARIANT_C_NAME } from "./VariantC.tsx";

const VARIANTS: VariantDef[] = [
  { key: "A", name: VARIANT_A_NAME },
  { key: "B", name: VARIANT_B_NAME },
  { key: "C", name: VARIANT_C_NAME },
];

function readVariant(): string {
  const v = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
  return VARIANTS.some(x => x.key === v) ? (v as string) : "A";
}

export function RunsPrototypeView(): React.ReactElement {
  const [variant, setVariant] = useState<string>(readVariant);

  // The app has no router; keep the URL shareable/reload-stable by hand.
  function change(key: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", key);
    window.history.replaceState(null, "", url.toString());
    setVariant(key);
  }

  return (
    <>
      {variant === "A" && <VariantA />}
      {variant === "B" && <VariantB />}
      {variant === "C" && <VariantC />}
      <PrototypeSwitcher variants={VARIANTS} current={variant} onChange={change} />
    </>
  );
}
