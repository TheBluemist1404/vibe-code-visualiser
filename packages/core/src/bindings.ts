// Implementation bindings (IR v0.2 §8). Kept outside the canonical IR: they link stable
// model IDs to code at an exact model revision and commit, and never change intent.
import type { Id } from "@vcv/ir";

export type BindingStatus = "confirmed" | "unverified" | "stale" | "missing" | "disputed";

export type Binding = {
  modelObjectId: Id;
  modelRevision: string;
  repositoryId: string;
  commit: string;
  locator: string;
  relation: "implements" | "exposes" | "persists" | "tests";
  provenance: "human" | "agent" | "inferred";
  confidence?: number;
  status: BindingStatus;
};

export type Snapshot = {
  modelRevision: string;
  /** Current commit per repository. */
  commits: Record<string, string>;
  /** Model objects whose definition changed since the binding's revision, if known. */
  changedObjectIds?: ReadonlySet<Id>;
};

/**
 * Decide what a binding's status should be now. A revision mismatch only means the
 * binding needs re-evaluation ("stale"); it is never reported as a contradiction.
 * Disputed/missing come from reconciliation with evidence, not from this check.
 */
export function assessBinding(b: Binding, now: Snapshot): BindingStatus {
  if (b.status === "disputed" || b.status === "missing") return b.status;
  const codeMoved = now.commits[b.repositoryId] !== b.commit;
  const modelMoved = now.modelRevision !== b.modelRevision;
  if (!codeMoved && !modelMoved) return b.status;
  // If we know exactly which objects changed and this one is not among them, a model-only
  // revision bump does not invalidate the binding's scope.
  if (!codeMoved && now.changedObjectIds && !now.changedObjectIds.has(b.modelObjectId)) return b.status;
  return "stale";
}
