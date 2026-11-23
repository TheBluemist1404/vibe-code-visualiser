// Staged edits: what the person intends to propose, held in the browser until it is submitted.
// Presentation state only. The draft remembers the model it was staged on (revision and model
// identity) and is never moved to a newer model without the person asking ("Restage").
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { EditableFieldName, GraphView, StagedEdit } from "../src/types.ts";

export type StagedEntry = StagedEdit & {
  /** For display only: what the field said when it was staged, and where it lives. */
  label: string;
  objectName: string;
  objectKind: string;
  before: string | string[] | null;
};

export type Draft = {
  base: { expectedRevision: string; modelKey: string };
  edits: StagedEntry[];
  rationale: string;
};

export type DraftApi = {
  draft: Draft | null;
  stage(entry: StagedEntry): void;
  unstage(objectId: string, field: EditableFieldName): void;
  staged(objectId: string, field: EditableFieldName): StagedEntry | undefined;
  setRationale(text: string): void;
  /** Keep the edits, and stage them on the model the canvas shows now. */
  restage(): void;
  clear(): void;
  /** Bumped after a proposal is recorded, so lists of proposals read again. */
  submitted: number;
  markSubmitted(): void;
};

const Ctx = createContext<DraftApi | null>(null);

export function useDraft(): DraftApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useDraft outside DraftProvider");
  return api;
}

/** Same value; a dependency list is a set, so its order does not count as a change. */
const same = (a: string | string[] | null, b: string | string[] | null) => {
  const norm = (v: typeof a) => JSON.stringify(Array.isArray(v) ? [...v].sort() : (v ?? null));
  return norm(a) === norm(b);
};

/**
 * Sits above the state screens, so staged edits survive a refresh, a branch switch or a moment
 * when the model is unreadable; they come back marked stale instead of being dropped.
 */
export function DraftProvider({ graph, children }: { graph: GraphView | null; children: React.ReactNode }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const revision = graph?.revision ?? null;
  const modelKey = graph?.modelKey ?? null;
  const [submitted, setSubmitted] = useState(0);
  const stage = useCallback(
    (entry: StagedEntry) =>
      setDraft((d) => {
        if (!d && (revision === null || modelKey === null)) return d;
        const base = d?.base ?? { expectedRevision: revision as string, modelKey: modelKey as string };
        const others = (d?.edits ?? []).filter((e) => !(e.objectId === entry.objectId && e.field === entry.field));
        // Staging the value the model already has is the same as unstaging.
        const edits = same(entry.value, entry.before) ? others : [...others, entry];
        return edits.length ? { base, edits, rationale: d?.rationale ?? "" } : null;
      }),
    [revision, modelKey],
  );

  const api = useMemo<DraftApi>(
    () => ({
      draft,
      stage,
      unstage: (objectId, field) =>
        setDraft((d) => {
          if (!d) return d;
          const edits = d.edits.filter((e) => !(e.objectId === objectId && e.field === field));
          return edits.length ? { ...d, edits } : null;
        }),
      staged: (objectId, field) => draft?.edits.find((e) => e.objectId === objectId && e.field === field),
      setRationale: (rationale) => setDraft((d) => (d ? { ...d, rationale } : d)),
      restage: () =>
        setDraft((d) => (d && revision && modelKey ? { ...d, base: { expectedRevision: revision, modelKey } } : d)),
      clear: () => setDraft(null),
      submitted,
      markSubmitted: () => setSubmitted((n) => n + 1),
    }),
    [draft, stage, submitted, revision, modelKey],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
