// Display names and colours for IR object kinds. The colour only tells kinds apart; it never
// signals a state or evidence.
import type { CSSProperties } from "react";

const LABELS: Record<string, [string, string]> = {
  capability: ["capability", "capabilities"],
  data: ["data", "data"],
  rule: ["rule", "rules"],
  event: ["event", "events"],
  contract: ["contract", "contracts"],
  behavior: ["behavior", "behaviors"],
  criterion: ["criterion", "criteria"],
  actor: ["actor", "actors"],
  module: ["module", "modules"],
  attribute: ["attribute", "attributes"],
  state: ["state", "states"],
  transition: ["transition", "transitions"],
};

export const KIND_ORDER = ["capability", "data", "rule", "event", "contract", "behavior", "criterion"];

export function kindLabel(kind: string, n = 1): string {
  const l = LABELS[kind];
  return l ? (n === 1 ? l[0] : l[1]) : kind;
}

export function kindTitle(kind: string, n = 2): string {
  const s = kindLabel(kind, n);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const kindVar = (kind: string): CSSProperties =>
  ({ "--k": `var(--k-${LABELS[kind] ? kind : "actor"})` }) as CSSProperties;
