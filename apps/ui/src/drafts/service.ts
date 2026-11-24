// Draft workflow for one checkout: create, stage, unstage, annotate, discard, dry-run and
// export local drafts. It writes only draft files in the UI state directory; the checkout, its
// .vcv/ store and Git are never written.
import { toStep } from "../edits.ts";
import type { ProjectSession } from "../session.ts";
import type { DraftExport, DraftList, DraftPreview, DraftView, ModelIdentity } from "../types.ts";
import { DRAFT_LIMITS, newDraftId } from "./format.ts";
import type { DraftFile } from "./format.ts";
import { handoff, handoffChange } from "./handoff.ts";
import { dryRun } from "./preview.ts";
import { DraftFileStore } from "./store.ts";
import type { Scope } from "./store.ts";

/** A request the draft workflow refuses (stale base, empty draft, bad input). */
export class DraftRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const stepKey = (s: { objectId: string; field: string }) => `${s.objectId}:${s.field}`;

function version(body: Record<string, unknown>): number {
  if (!Number.isInteger(body.version))
    throw new DraftRefused("INVALID_REQUEST", "send the draft version you are editing");
  return body.version as number;
}

export class DraftDesk {
  private readonly session: ProjectSession;
  readonly store: DraftFileStore;

  constructor(session: ProjectSession, stateDir: string) {
    this.session = session;
    this.store = new DraftFileStore(stateDir);
  }

  /** The current snapshot, its scope and its identity. */
  private now() {
    const snap = this.session.ready();
    const scope: Scope = { root: snap.status.root, projectId: snap.model.project.id };
    const identity: ModelIdentity = {
      revision: snap.model.project.modelRevision,
      modelKey: snap.key,
      branch: snap.status.git?.branch ?? null,
      commit: snap.status.git?.commit ?? null,
    };
    return { snap, scope, identity };
  }

  list(): DraftList {
    const { scope, identity } = this.now();
    const { drafts, problems } = this.store.list(scope);
    return { drafts: drafts.map((d) => view(d, identity)), problems, current: identity };
  }

  get(draftId: string): DraftView {
    const { scope, identity } = this.now();
    return view(this.store.read(scope, draftId), identity);
  }

  create(): DraftView {
    const { scope, identity } = this.now();
    const at = new Date().toISOString();
    const draft: DraftFile = {
      format: "vcv-ui-draft-1",
      draftId: newDraftId(),
      version: 1,
      checkoutRoot: scope.root,
      projectId: scope.projectId,
      base: identity,
      steps: [],
      rationale: "",
      createdAt: at,
      updatedAt: at,
    };
    return view(this.store.write(scope, draft, null), identity);
  }

  /**
   * Stage one edit as a typed operation built against the draft's base model, which must be the
   * model the checkout holds now. A stale draft takes no new edits: building them against a
   * newer model would mix two bases in one change.
   */
  stage(draftId: string, body: Record<string, unknown>): DraftView {
    const { snap, scope, identity } = this.now();
    const draft = this.store.read(scope, draftId);
    if (draft.base.modelKey !== identity.modelKey)
      throw new DraftRefused(
        "DRAFT_STALE",
        `this draft is based on ${draft.base.revision} (${draft.base.modelKey}); the checkout now holds ${identity.revision}. Export it for an agent to integrate, or start a new draft.`,
      );
    const step = toStep(snap.model, body.edit);
    const at = draft.steps.findIndex((s) => stepKey(s) === stepKey(step));
    const unchanged = JSON.stringify(norm(step.after)) === JSON.stringify(norm(step.before));
    const steps = [...draft.steps];
    // Re-staging a field corrects its step in place; staging the model's own value removes it.
    if (unchanged) {
      if (at >= 0) steps.splice(at, 1);
    } else if (at >= 0) steps[at] = step;
    else steps.push(step);
    if (steps.length > DRAFT_LIMITS.steps)
      throw new DraftRefused("DRAFT_FULL", `a draft holds at most ${DRAFT_LIMITS.steps} edits`);
    return this.save(scope, identity, draft, version(body), { steps });
  }

  unstage(draftId: string, body: Record<string, unknown>): DraftView {
    const { scope, identity } = this.now();
    const draft = this.store.read(scope, draftId);
    if (typeof body.key !== "string") throw new DraftRefused("INVALID_REQUEST", "name the step to remove (key)");
    const steps = draft.steps.filter((s) => stepKey(s) !== body.key);
    if (steps.length === draft.steps.length)
      throw new DraftRefused("UNKNOWN_STEP", `no step ${body.key} in this draft`);
    return this.save(scope, identity, draft, version(body), { steps });
  }

  annotate(draftId: string, body: Record<string, unknown>): DraftView {
    const { scope, identity } = this.now();
    const draft = this.store.read(scope, draftId);
    if (typeof body.rationale !== "string" || body.rationale.length > DRAFT_LIMITS.rationale)
      throw new DraftRefused("INVALID_REQUEST", `rationale is text of at most ${DRAFT_LIMITS.rationale} characters`);
    return this.save(scope, identity, draft, version(body), { rationale: body.rationale });
  }

  /** Delete a draft on purpose. `version: null` is accepted only for an unreadable file. */
  discard(draftId: string, body: Record<string, unknown>): { discarded: string } {
    const { scope } = this.now();
    const expected = body.version === null ? null : version(body);
    this.store.discard(scope, draftId, expected);
    return { discarded: draftId };
  }

  /** The engine's dry run of the draft on its own base revision. Writes nothing. */
  preview(draftId: string): DraftPreview {
    const { draft, identity } = this.nonEmpty(draftId);
    return dryRun(this.session.path, handoffChange(draft), identity.revision);
  }

  /** The handoff for an agent, labelled with what the dry run found. Writes nothing. */
  export(draftId: string): DraftExport {
    const { draft, identity } = this.nonEmpty(draftId);
    return handoff(draft, identity, dryRun(this.session.path, handoffChange(draft), identity.revision));
  }

  private nonEmpty(draftId: string) {
    const { scope, identity } = this.now();
    const draft = this.store.read(scope, draftId);
    if (draft.steps.length === 0) throw new DraftRefused("EMPTY_DRAFT", "stage at least one edit first");
    return { draft, identity };
  }

  private save(
    scope: Scope,
    identity: ModelIdentity,
    draft: DraftFile,
    expected: number,
    change: Partial<Pick<DraftFile, "steps" | "rationale">>,
  ): DraftView {
    const next: DraftFile = { ...draft, ...change, version: expected + 1, updatedAt: new Date().toISOString() };
    return view(this.store.write(scope, next, expected), identity);
  }
}

const norm = (v: string | string[] | null) => (Array.isArray(v) ? [...v].sort() : (v ?? null));

function view(d: DraftFile, current: ModelIdentity): DraftView {
  return {
    draftId: d.draftId,
    version: d.version,
    projectId: d.projectId,
    base: d.base,
    steps: d.steps.map((s) => ({ ...s, key: stepKey(s) })),
    rationale: d.rationale,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    stale: d.base.modelKey !== current.modelKey,
    current,
  };
}
