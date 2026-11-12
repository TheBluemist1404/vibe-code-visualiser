// Agent-accessible model proposals and the pre-approval review surface (Issue #17, M3.1).
//
// One shared layer behind the CLI (`vcv proposal ...`) and MCP (`vcv_*_proposal*`). It adds no
// model writer: submitting goes through ModelEngine.propose, and previews call the same
// checkChange() the engine decides on. What this layer adds is
//
//   - a proposal-only entry point: whatever permissions the host holds, a submission here can only
//     ever create a pending (or rejected) change record. It never applies, never approves and
//     never moves .vcv/HEAD, so it is safe to hand to a coding agent;
//   - a bounded, read-only preview of a proposal (submitted or not): its operations, the object
//     level before/after delta, structural impact (modules, contracts, cross-module effects),
//     binding claims that touch the changed objects, the engine's diagnostics now, and the
//     assumptions nobody has verified;
//   - a lifecycle that keeps four things apart: the change record's state (rejected, pending,
//     stale, applied), the model snapshot's own draft/approved status, binding resolution, and
//     implementation (never inferred: approval does not mean the code was written; an implementing
//     agent's report, M3.3, is a separate claim read with `vcv implementation show`).
//
// Previews and listings never write anything, not even store recovery (FileStoreReader).
import { z } from "zod";
import { createHash } from "node:crypto";
import { buildIndex, persistedIdProblem } from "@vcv/ir";
import type { Diagnostic, Id, Model } from "@vcv/ir";
import {
  FileStore,
  FileStoreReader,
  ModelEngine,
  applyOperations,
  canonicalJson,
  checkChange,
  listChangeRecords,
  proposalDigest,
  proposedChangeSchema,
  storeFingerprint,
} from "@vcv/core";
import type { ChangeRecord, ChangeRecordEntry, ChangeStatus, HostContext, ImplementationRequest, ProposedModelChange } from "@vcv/core";
import { LIMITS as QUERY_LIMITS, createQueryApi } from "@vcv/query";
import type { ImpactCandidate } from "@vcv/query";
import { listBindings } from "./bindings.ts";
import type { ClaimEntry } from "./bindings.ts";
import { headCommit } from "./git.ts";
import { formatLocator } from "./locator.ts";
import { projectStatus } from "./project.ts";
import type { ProjectStatus } from "./project.ts";

export const PROPOSAL_LIMITS = {
  /** Operations per proposal accepted by this surface. */
  maxOperations: 100,
  /** Canonical JSON size of one proposal accepted by this surface. */
  maxBytes: 256 * 1024,
  list: { default: 50, max: 200 },
  /** Object changes, impact candidates and binding claims listed per preview. */
  items: { default: 50, max: 200 },
  /** Characters of one before/after field value shown in a preview. */
  valueChars: 300,
} as const;

// ---- requests --------------------------------------------------------------------------

const persistedId = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => persistedIdProblem(v) === undefined, { message: "must use the persisted-ID grammar (lowercase letters, digits, '.', '-', '_')" });

export const listProposalsRequest = z
  .object({
    lifecycles: z.array(z.enum(["pending", "stale", "rejected", "applied", "invalid"])).min(1).max(5).optional(),
    limit: z.number().int().min(1).max(PROPOSAL_LIMITS.list.max).default(PROPOSAL_LIMITS.list.default),
  })
  .strict();

export const previewProposalRequest = z
  .object({
    /** A submitted proposal, by change ID. */
    changeId: persistedId.optional(),
    /** Or a proposal that has not been submitted (a dry run): the same object `submit` takes. */
    change: proposedChangeSchema.optional(),
    limit: z.number().int().min(1).max(PROPOSAL_LIMITS.items.max).default(PROPOSAL_LIMITS.items.default),
  })
  .strict()
  .refine((r) => (r.changeId === undefined) !== (r.change === undefined), { message: "pass exactly one of changeId or change" });

export type ListProposalsRequest = z.input<typeof listProposalsRequest>;
export type PreviewProposalRequest = z.input<typeof previewProposalRequest>;

// ---- results ---------------------------------------------------------------------------

export type ProposalErrorCode =
  | "INVALID_REQUEST"
  /** The project is absent, uninitialized, conflicted, diverged or invalid. */
  | "PROJECT_NOT_READY"
  /** No change record with this ID in this checkout. */
  | "UNKNOWN_CHANGE"
  /** The change record file exists but cannot be read as a record. */
  | "INVALID_RECORD"
  /** The model store could not be read. */
  | "STORE_ERROR"
  /** The checkout, model store, change records or claims changed while reading (e.g. a Git checkout). Nothing was mixed; retry. */
  | "STATE_CHANGED"
  // M3.3 handoff and implementation reports:
  /** The change is not applied (pending, rejected): there is nothing approved to implement. */
  | "NOT_APPLIED"
  /** The change's resulting revision is not in this checkout's model history (another branch?). */
  | "NOT_IN_HISTORY"
  /** The change has no attestation whose signature verifies against its record. */
  | "NOT_ATTESTED"
  /** A commit named in the request is not in this repository, or not an ancestor of HEAD. */
  | "UNKNOWN_COMMIT"
  /** An implementation report for this change exists; pass its digest to replace it. */
  | "REPORT_EXISTS"
  /** The existing report's digest is not the one passed. */
  | "REPORT_CHANGED"
  /** The implementations directory or report file is not a plain directory/file. */
  | "UNSAFE_PATH"
  /** No implementation report for this change. */
  | "NO_REPORT"
  /** The handoff would exceed its byte limit even with every derived list cut. */
  | "HANDOFF_TOO_LARGE"
  /** M4.1: the reconciliation report would exceed its byte budget even with every list cut. */
  | "REPORT_TOO_LARGE"
  /** M4.3: a test report that cannot be read as the supported JUnit XML subset. */
  | "REPORT_INVALID"
  /** M4.3: a test report whose declared counts do not match its cases (truncated or edited). */
  | "REPORT_INCONSISTENT"
  /** M4.3: the candidate changed between reading its identity and capturing the run. */
  | "TEST_RUN_RACED"
  /** M4.3: a test-run record that does not check (shape, digest, summary). */
  | "RUN_INVALID"
  /** M4.3: the candidate's source cannot be identified exactly (no Git commit, a failed Git read, too much to hash). */
  | "SOURCE_IDENTITY_UNAVAILABLE";

export type ProposalError = { code: ProposalErrorCode; message: string; details?: { path: string; message: string }[] };

export type ProposalContext = {
  projectId: string;
  /** The revision .vcv/HEAD names in this checkout now. */
  modelRevision: string;
  /** The model snapshot's own status. Says nothing about any change record's approval. */
  snapshotStatus: string;
  source: "model-proposals";
  /** Always false: nothing here looks at code. */
  implementationChecked: false;
  observed: { commit: string | null; branch: string | null; dirty: boolean | null };
};

export type ProposalResult<T> = { ok: true; context: ProposalContext; data: T } | { ok: false; context?: ProposalContext; error: ProposalError };

/** An engine diagnostic plus what to do about it. */
export type HintedDiagnostic = Diagnostic & { hint?: string };

/**
 * Where a proposal is, derived from its record and this checkout's model; never stored.
 *   rejected  failed validation when submitted (or when an approval rechecked it); final
 *   pending   validated, waiting for a separate reviewer; .vcv/HEAD is unchanged
 *   stale     still pending, but this checkout's model is no longer its base revision, so an
 *             approval would fail: submit a new proposal against the current revision
 *   applied   approved (or applied by a host allowed to) and committed as a model revision
 *   invalid   the record file is unreadable
 */
export type ProposalLifecycle = "rejected" | "pending" | "stale" | "applied" | "invalid";

/**
 * What the change record says about how it was applied, never who really decided (M3.2 adds the
 * trusted reviewer step). "approved-by-separate-reviewer": applied with an approverId other than
 * the proposer; "applied-by-host": applied without a separate approver (direct apply by a host
 * holding model:apply, or a self-approval the policy allowed); "none": not applied.
 */
export type ApprovalState = "none" | "applied-by-host" | "approved-by-separate-reviewer";

export function approvalOf(r: ChangeRecord | undefined): ApprovalState {
  if (r?.status !== "applied") return "none";
  return r.approverId && r.approverId !== r.proposerId ? "approved-by-separate-reviewer" : "applied-by-host";
}

export type ProposalSummary = {
  changeId: string;
  lifecycle: ProposalLifecycle;
  /** The record's own status field, as stored. */
  recordStatus: ChangeStatus | null;
  proposerId: string | null;
  baseRevision: string | null;
  /** For lifecycle "stale": the base was an earlier revision of this line, or is not in it at all. */
  stale?: { reason: "superseded" | "other-line"; detail: string };
  resultingRevision?: string;
  /** For applied records: whether this checkout's history contains the resulting revision. */
  resultInThisCheckout?: boolean;
  /** As recorded in the change record. A file in the repository is not proof of who approved (docs/proposals.md). */
  recordedApproverId?: string;
  approval: ApprovalState;
  /** sha256 of the proposal content; what a reviewer saw. */
  proposalDigest: string | null;
  operations: number;
  rationale?: string;
  problem?: string;
  /** Approval of intent is never implementation: VCV records no implementation state. */
  implementation: { state: "not-recorded"; note: string };
};

export type ProposalList = { proposals: ProposalSummary[]; total: number; matched: number; truncated: boolean; counts: Record<ProposalLifecycle, number> };

export type FieldChange = { field: string; before?: string; after?: string; truncated?: true };

export type ObjectChange = {
  id: Id;
  kind: string;
  name: string;
  /** Module the object belongs to (after the change, or before it for removals). */
  moduleId: Id | null;
  change: "added" | "removed" | "modified";
  fields: FieldChange[];
};

export type ProposalPreview = {
  proposal: {
    changeId: string;
    proposalDigest: string;
    /** "record": a submitted proposal; "unsubmitted": a dry run of a change object. */
    origin: "record" | "unsubmitted";
    lifecycle: ProposalLifecycle | "unsubmitted";
    proposerId: string | null;
    projectId: string;
    baseRevision: string;
    rationale?: string;
    operations: { index: number; type: string; summary: string }[];
    /** What the proposer asks to be implemented after approval (covered by the digest). */
    implementation?: ImplementationRequest;
  };
  /** The engine's checkChange() against this checkout's current model, now. */
  validation: {
    appliesToCurrent: boolean;
    errors: HintedDiagnostic[];
    warnings: HintedDiagnostic[];
    /** Diagnostics stored on the record when it was submitted (records only). */
    atSubmission?: HintedDiagnostic[];
  };
  /**
   * The model delta the operations make. Against the current revision when they apply to it;
   * against the base revision when that is an earlier revision of this line (a stale proposal);
   * null when they cannot be applied to either (the errors say why).
   */
  delta: { against: "current" | "base"; revision: string; changes: ObjectChange[]; total: number; truncated: boolean } | null;
  impact: {
    /** Modules owning a changed object ("changed") or a structural impact candidate ("impacted"). */
    modules: { id: Id; name: string; via: "changed" | "impacted" }[];
    /** "not-determined": one module seen, but the impact list was cut, so others may be affected. */
    crossModule: "yes" | "no" | "not-determined";
    contracts: { id: Id; name: string; moduleId: Id | null; via: "changed" | "impacted" }[];
    candidates: ImpactCandidate[];
    total: number;
    truncated: boolean;
    impactClass: "structural-candidate";
    note: string;
  } | null;
  /** Binding claims about changed, removed or impacted objects: code that probably has to move with this change. */
  bindings: {
    items: { bindingId: string; modelObjectId: Id; relation: string; locator: string; why: "changed" | "removed" | "impacted" }[];
    total: number;
    truncated: boolean;
    note: string;
  };
  /** Kept apart on purpose: none of these implies another. */
  states: {
    snapshotStatus: string;
    change: ProposalLifecycle | "unsubmitted";
    approval: ApprovalState;
    implementation: "not-recorded";
  };
  /** What nobody has checked. Read these before approving. */
  assumptions: string[];
};

export type SubmitResult = {
  /** True when a new pending proposal was recorded. */
  ok: boolean;
  status: "pending" | "rejected" | "denied";
  changeId: string | null;
  proposalDigest: string | null;
  /** Whether this call created a change record (replays, denials and malformed input do not). */
  recorded: boolean;
  baseRevision: string | null;
  /** .vcv/HEAD before and after the call: always equal on this surface. */
  modelRevision: { before: string; after: string };
  diagnostics: HintedDiagnostic[];
  next: string;
};

// ---- hints -----------------------------------------------------------------------------

const HINTS: Record<string, string> = {
  SCHEMA: "The proposal does not match the typed change schema: fix the field at `path` (see docs/proposals.md for the operations and their parameters).",
  NOT_AUTHORIZED: "This host may not propose model changes; ask the person running VCV for model:propose.",
  DUPLICATE_CHANGE: "Change IDs are immutable and used once: choose a new changeId (the existing record is left as it was).",
  WRONG_PROJECT: "Set projectId to the project's ID (vcv project status or vcv_get_project_overview).",
  STALE_REVISION: "The model moved since you read it: re-read the current revision, re-check your operations against it, and submit a new proposal with that expectedRevision.",
  ID_IN_USE: "Pick an ID that does not exist yet (vcv_search_objects / vcv query search).",
  TARGET_MISSING: "The operation names an object that does not exist at the base revision; check the ID with vcv_get_context.",
  REFERENCED: "Remove or redirect the references listed first (in an earlier operation of the same proposal), then remove the object.",
  HAS_OWNED_OBJECTS: "Remove or move the owned objects first, in earlier operations of the same proposal.",
  TOO_LARGE: `Split the change: this surface accepts at most ${PROPOSAL_LIMITS.maxOperations} operations and ${PROPOSAL_LIMITS.maxBytes} bytes per proposal.`,
  HEAD_CHANGED: "The model store moved while the proposal was being recorded (e.g. a Git checkout); nothing was written. Re-read and submit again.",
  STORE_CHANGED: "The model store changed while the proposal was being recorded; nothing was written. Re-read and submit again.",
  UNKNOWN_REF: "A reference points at an ID that does not exist after the change; create the target in an earlier operation of the same proposal or fix the ID.",
  WRONG_KIND: "A reference points at an object of the wrong kind; check the target's kind with vcv_get_context.",
  DEPENDENCY_CYCLE: "The module dependencies would form a cycle; change setModuleDependencies so the graph stays acyclic.",
  UNRESOLVED_IN_APPROVED: "An approved snapshot may not hold unresolved placeholders; resolve them in this proposal, or leave the snapshot a draft.",
  UNRESOLVED_REF: "A reference points at an ID that does not exist after the change; add the target in an earlier operation or fix the ID.",
};

function hinted(ds: readonly Diagnostic[]): HintedDiagnostic[] {
  return ds.map((d) => (HINTS[d.code] ? { ...d, hint: HINTS[d.code] } : { ...d }));
}

const NOT_IMPLEMENTED = "VCV never infers implementation. Approving a change approves intent only; code, tests and binding claims are separate work and separate evidence. An implementing agent's report (vcv implementation record) is a separate, unverified claim and is not shown here.";

// ---- submit ----------------------------------------------------------------------------

/**
 * Submit a typed model change for review. Proposal-only: the host's permissions are narrowed to
 * model:propose, so the engine can only record it as pending (or rejected), whatever else the
 * caller may hold. Throws only when the project cannot be opened (StoreError) or on a bug.
 */
export function submitProposal(path: string, input: unknown, host: HostContext): ProposalResult<SubmitResult> {
  const status = projectStatus(path);
  if (status.state !== "ready" || !status.model) return notReady(status);
  const before = status.model.revision;
  const size = sizeProblem(input);
  const ctx: HostContext = { principalId: host.principalId, permissions: host.permissions.filter((p) => p === "model:propose") };
  const engine = new ModelEngine(new FileStore(status.storeDir));
  if (size && ctx.permissions.length) {
    const claimed = typeof (input as { changeId?: unknown })?.changeId === "string" ? ((input as { changeId: string }).changeId) : null;
    return okWith(status, new FileStoreReader(status.storeDir).current(), {
      ok: false,
      status: "rejected",
      changeId: claimed,
      proposalDigest: null,
      recorded: false,
      baseRevision: null,
      modelRevision: { before, after: before },
      diagnostics: hinted([{ code: "TOO_LARGE", severity: "error", path: size.path, message: size.message }]),
      next: "Nothing was recorded.",
    });
  }
  const existing = typeof (input as { changeId?: unknown })?.changeId === "string" && !persistedIdProblem((input as { changeId: string }).changeId)
    ? engine.record((input as { changeId: string }).changeId)
    : undefined;
  const outcome = engine.propose(input, ctx);
  const afterModel = new FileStoreReader(status.storeDir).current();
  const after = afterModel.project.modelRevision;
  if (after !== before) {
    // Unreachable by construction (no model:apply), but this is the guarantee the surface makes.
    throw new Error(`proposal-only surface moved .vcv/HEAD from ${before} to ${after}`);
  }
  const record = outcome.record;
  const recorded = !!record && !existing && outcome.status !== "denied";
  const status_ = outcome.status === "applied" ? "rejected" : outcome.status; // never "applied" here
  return okWith(status, afterModel, {
    ok: outcome.status === "pending" && recorded,
    status: status_,
    changeId: outcome.changeId ?? null,
    proposalDigest: record && recorded ? proposalDigest(record.change) : null,
    recorded,
    baseRevision: record && recorded ? record.baseRevision : null,
    modelRevision: { before, after },
    diagnostics: hinted(outcome.diagnostics),
    next:
      outcome.status === "pending"
        ? `Recorded as pending; .vcv/HEAD is still ${after}. A separate reviewer must approve it before anything is implemented. Preview: vcv proposal preview <path> ${outcome.changeId}`
        : recorded
          ? "Recorded as rejected (the record keeps the diagnostics). Fix the proposal and submit it under a new changeId."
          : "Nothing was recorded.",
  });
}

function sizeProblem(input: unknown): { path: string; message: string } | undefined {
  const ops = (input as { operations?: unknown })?.operations;
  if (Array.isArray(ops) && ops.length > PROPOSAL_LIMITS.maxOperations) {
    return { path: "operations", message: `${ops.length} operations; this surface accepts at most ${PROPOSAL_LIMITS.maxOperations}` };
  }
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(canonicalJson(input ?? null));
  } catch {
    return { path: "", message: "proposal is not plain data" };
  }
  return bytes > PROPOSAL_LIMITS.maxBytes ? { path: "", message: `${bytes} bytes; this surface accepts at most ${PROPOSAL_LIMITS.maxBytes}` } : undefined;
}

// ---- list ------------------------------------------------------------------------------

/** Every proposal recorded in this checkout with its derived lifecycle. Read-only. */
export function listProposals(path: string, input: unknown = {}, hooks: ProposalHooks = {}): ProposalResult<ProposalList> {
  const parsed = listProposalsRequest.safeParse(input ?? {});
  if (!parsed.success) return invalid(parsed.error);
  return observed(path, hooks, (obs) => {
    const { model, history } = obs;
    const all = obs.records.map((e) => summarize(e.changeId, e.record, e.problem, model, history));
    const counts: Record<ProposalLifecycle, number> = { pending: 0, stale: 0, rejected: 0, applied: 0, invalid: 0 };
    for (const p of all) counts[p.lifecycle]++;
    const wanted = parsed.data.lifecycles;
    const matched = wanted ? all.filter((p) => wanted.includes(p.lifecycle)) : all;
    return finish(obs, hooks, {
      proposals: matched.slice(0, parsed.data.limit),
      total: all.length,
      matched: matched.length,
      truncated: matched.length > parsed.data.limit,
      counts,
    });
  });
}

function lifecycleOf(r: ChangeRecord, model: Model, history: readonly string[]): Pick<ProposalSummary, "lifecycle" | "stale" | "resultInThisCheckout"> {
  switch (r.status) {
    case "applied":
      return { lifecycle: "applied", resultInThisCheckout: !!r.resultingRevision && history.includes(r.resultingRevision) };
    case "pending": {
      const current = model.project.modelRevision;
      if (r.baseRevision === current) return { lifecycle: "pending" };
      return {
        lifecycle: "stale",
        stale: history.includes(r.baseRevision)
          ? { reason: "superseded", detail: `based on ${r.baseRevision}; this checkout has moved on to ${current}` }
          : { reason: "other-line", detail: `based on ${r.baseRevision}, which is not in this checkout's history (another branch?)` },
      };
    }
    default:
      return { lifecycle: "rejected" };
  }
}

function summarize(changeId: string, r: ChangeRecord | undefined, problem: string | undefined, model: Model, history: readonly string[]): ProposalSummary {
  const implementation = { state: "not-recorded" as const, note: NOT_IMPLEMENTED };
  const parsed = r ? proposedChangeSchema.safeParse(r.change) : undefined;
  if (!r || !parsed?.success) {
    return {
      changeId,
      lifecycle: "invalid",
      recordStatus: null,
      proposerId: null,
      baseRevision: null,
      proposalDigest: null,
      operations: 0,
      problem: problem ?? "the record's change does not match the typed change schema",
      approval: "none",
      implementation,
    };
  }
  return {
    changeId,
    ...lifecycleOf(r, model, history),
    recordStatus: r.status,
    proposerId: r.proposerId ?? null,
    baseRevision: r.baseRevision ?? null,
    ...(r.status === "applied" && r.resultingRevision ? { resultingRevision: r.resultingRevision } : {}),
    ...(r.approverId ? { recordedApproverId: r.approverId } : {}),
    approval: approvalOf(r),
    proposalDigest: proposalDigest(parsed.data),
    operations: parsed.data.operations.length,
    ...(parsed.data.rationale ? { rationale: parsed.data.rationale } : {}),
    implementation,
  };
}

// ---- preview ---------------------------------------------------------------------------

/**
 * A bounded, read-only review of one proposal: what it changes, what that structurally touches,
 * whether the engine would accept it now, and what nobody has verified. Writes nothing.
 */
export function previewProposal(path: string, input: unknown, hooks: ProposalHooks = {}): ProposalResult<ProposalPreview> {
  const parsed = previewProposalRequest.safeParse(input ?? {});
  if (!parsed.success) return invalid(parsed.error);
  const req = parsed.data;
  return observed(path, hooks, (obs) => {
    const { model, history, reader } = obs;
    let change: ProposedModelChange;
    let record: ChangeRecord | undefined;
    if (req.changeId !== undefined) {
      const entry = obs.records.find((e) => e.changeId === req.changeId);
      if (!entry) return failFinal({ code: "UNKNOWN_CHANGE", message: `no change record "${req.changeId}" in this checkout` }, obs, hooks);
      const c = entry.record ? proposedChangeSchema.safeParse(entry.record.change) : undefined;
      if (!entry.record || !c?.success) {
        return failFinal({ code: "INVALID_RECORD", message: `change record "${req.changeId}" is unreadable: ${entry.problem ?? "its change does not match the typed change schema"}` }, obs, hooks);
      }
      record = entry.record;
      change = c.data;
    } else {
      const size = sizeProblem(req.change);
      if (size) return failFinal({ code: "INVALID_REQUEST", message: `change is too large: ${size.message}`, details: [{ path: `change.${size.path}`, message: HINTS.TOO_LARGE! }] }, obs, hooks);
      change = req.change!;
    }

    const lifecycle: ProposalLifecycle | "unsubmitted" = record ? lifecycleOf(record, model, history).lifecycle : "unsubmitted";
    const check = checkChange(change, model);

    // The delta: against the current revision if the operations apply there, otherwise against
    // the base revision when that is an earlier revision of this line.
    let delta: { against: "current" | "base"; before: Model; after: Model } | null = null;
    if (check.model) delta = { against: "current", before: model, after: check.model };
    else if (change.expectedRevision !== model.project.modelRevision && history.includes(change.expectedRevision) && change.projectId === model.project.id) {
      const base = readRevision(reader, change.expectedRevision);
      const applied = base && applyOperations(base, change.operations);
      if (base && applied && "model" in applied) delta = { against: "base", before: base, after: applied.model };
    }

    const limit = req.limit;
    const changes = delta ? diffModels(delta.before, delta.after) : [];
    const impact = delta ? impactOf(delta.before, delta.after, changes, limit) : null;
    const claims = readClaims(obs.status.root);
    const bindingItems = bindingsFor(claims.entries, changes, impact?.candidates ?? []);

    return finish(obs, hooks, {
      proposal: {
        changeId: change.changeId,
        proposalDigest: proposalDigest(change),
        origin: record ? "record" : "unsubmitted",
        lifecycle,
        proposerId: record?.proposerId ?? null,
        projectId: change.projectId,
        baseRevision: change.expectedRevision,
        ...(change.rationale ? { rationale: change.rationale } : {}),
        operations: change.operations.map((op, index) => ({ index, type: op.type, summary: describeOperation(op) })),
        ...(change.implementation ? { implementation: change.implementation } : {}),
      },
      validation: {
        appliesToCurrent: !!check.model,
        errors: hinted(check.errors),
        warnings: hinted(check.warnings),
        ...(record ? { atSubmission: hinted(record.validationResults ?? []) } : {}),
      },
      delta: delta
        ? { against: delta.against, revision: delta.before.project.modelRevision, changes: changes.slice(0, limit), total: changes.length, truncated: changes.length > limit }
        : null,
      impact,
      bindings: {
        items: bindingItems.slice(0, limit),
        total: bindingItems.length,
        truncated: bindingItems.length > limit,
        note: "Claims are listed, not verified, here: run vcv evidence (or vcv_get_object_evidence) for their current state. After implementation they must be re-checked and reasserted explicitly.",
      },
      states: {
        snapshotStatus: model.project.status,
        change: lifecycle,
        approval: approvalOf(record),
        implementation: "not-recorded",
      },
      assumptions: assumptionsFor(change, record, lifecycle, impact, bindingItems.length),
    }, { key: claims.key, again: () => readClaims(obs.status.root).key });
  });
}

export function readRevision(reader: FileStoreReader, rev: string): Model | undefined {
  try {
    return reader.revision(rev);
  } catch {
    return undefined;
  }
}

function assumptionsFor(
  change: ProposedModelChange,
  record: ChangeRecord | undefined,
  lifecycle: ProposalLifecycle | "unsubmitted",
  impact: ProposalPreview["impact"],
  bindings: number,
): string[] {
  const out = [
    "The impact list is structural: it follows declared model references only. It is not a code, test or runtime impact analysis, and an empty list does not mean nothing else is affected.",
    "Whether the operations express the requested behavior is the proposer's interpretation; VCV checks types, references and invariants, not meaning.",
    "The current source code has not been compared with this proposal. Approval approves model intent; the implementation comes afterwards and is checked separately.",
  ];
  if (record) out.push(`The proposer identity "${record.proposerId}" is what the host asserted when the proposal was submitted; see docs/proposals.md for what that proves locally.`);
  if (!change.rationale) out.push("The proposal carries no rationale: ask the proposer what request it implements.");
  if (!change.implementation) out.push("The proposal states no implementation request (behavior, acceptance criteria, scope): the implementation handoff will have none to give the coding agent.");
  else if (!change.implementation.scope) out.push("The implementation request declares no code scope: every changed file will be reported as unscoped.");
  if (lifecycle === "stale") out.push("This proposal is stale: the delta shown is against its base revision, and an approval would fail. It needs a new proposal against the current revision.");
  if (impact?.crossModule === "not-determined") out.push("Whether the change reaches other modules is not determined: the impact list was cut before all candidates were seen.");
  if (impact?.crossModule === "yes") out.push("The change reaches more than one module: check each module's contracts and binding claims, not only the module that was asked about.");
  if (impact?.truncated) out.push("The impact list was cut by its budget: more objects may be affected than are listed.");
  if (bindings === 0) out.push("No binding claims point at the changed or impacted objects, so the code they correspond to is not known to VCV.");
  return out;
}

// ---- delta -----------------------------------------------------------------------------

type Item = { id: Id; kind: string; name: string; fields: Record<string, unknown> };

/** Field-level records for every object, nested elements as their own items. */
function items(m: Model): Map<Id, Item> {
  const out = new Map<Id, Item>();
  const { project } = m;
  const { modelRevision: _rev, ...projectFields } = project;
  out.set(project.id, { id: project.id, kind: "project", name: project.name, fields: projectFields });
  const put = (kind: string, o: { id: Id; name?: string }, omit: string[] = []) => {
    const fields = Object.fromEntries(Object.entries(o).filter(([k]) => !omit.includes(k)));
    out.set(o.id, { id: o.id, kind, name: o.name ?? o.id, fields });
  };
  for (const x of m.actors) put("actor", x);
  for (const x of m.modules) put("module", x);
  for (const x of m.capabilities) put("capability", x);
  for (const x of m.rules) put("rule", x);
  for (const x of m.events) put("event", x);
  for (const x of m.contracts) put("contract", x);
  for (const d of m.data) {
    put("data", d, ["attributes"]);
    for (const a of d.attributes) put("attribute", a);
  }
  for (const x of m.criteria ?? []) put("criterion", x);
  for (const b of m.behaviors) {
    put("behavior", b, ["states", "transitions"]);
    for (const s of b.states) put("state", s);
    for (const t of b.transitions) put("transition", t);
  }
  return out;
}

export function moduleOf(m: Model, id: Id): Id | null {
  const index = buildIndex(m).byId;
  let e = index.get(id);
  while (e) {
    if (e.kind === "module") return e.id;
    if (!e.parentId) return null;
    e = index.get(e.parentId);
  }
  return null;
}

const show = (v: unknown): { text?: string; truncated?: true } => {
  if (v === undefined) return {};
  const text = typeof v === "string" ? v : canonicalJson(v);
  return text.length > PROPOSAL_LIMITS.valueChars ? { text: `${text.slice(0, PROPOSAL_LIMITS.valueChars)}…`, truncated: true } : { text };
};

/** Object-level before/after delta, in a stable order (kind, then ID). */
export function diffModels(before: Model, after: Model): ObjectChange[] {
  const a = items(before);
  const b = items(after);
  const out: ObjectChange[] = [];
  const ids = [...new Set([...a.keys(), ...b.keys()])];
  for (const id of ids) {
    const x = a.get(id);
    const y = b.get(id);
    const fields: FieldChange[] = [];
    const keys = [...new Set([...Object.keys(x?.fields ?? {}), ...Object.keys(y?.fields ?? {})])].sort();
    for (const k of keys) {
      const bv = x?.fields[k];
      const av = y?.fields[k];
      if (canonicalJson(bv ?? null) === canonicalJson(av ?? null)) continue;
      const bs = show(bv);
      const as = show(av);
      fields.push({
        field: k,
        ...(bs.text !== undefined ? { before: bs.text } : {}),
        ...(as.text !== undefined ? { after: as.text } : {}),
        ...(bs.truncated || as.truncated ? { truncated: true as const } : {}),
      });
    }
    if (x && y && !fields.length) continue;
    const item = (y ?? x)!;
    out.push({
      id,
      kind: item.kind,
      name: item.name,
      moduleId: y ? moduleOf(after, id) : moduleOf(before, id),
      change: !x ? "added" : !y ? "removed" : "modified",
      fields,
    });
  }
  return out.sort((p, q) => (p.kind === q.kind ? (p.id < q.id ? -1 : p.id > q.id ? 1 : 0) : p.kind < q.kind ? -1 : 1));
}

export function impactOf(before: Model, after: Model, changes: ObjectChange[], limit: number): NonNullable<ProposalPreview["impact"]> {
  const seen = new Map<Id, ImpactCandidate>();
  let truncated = false;
  const changedIds = new Set(changes.map((c) => c.id));
  const run = (m: Model, ids: Id[]) => {
    for (let i = 0; i < ids.length; i += QUERY_LIMITS.impact.maxSeeds) {
      const r = createQueryApi({ current: () => m }).analyzeImpact({ ids: ids.slice(i, i + QUERY_LIMITS.impact.maxSeeds), maxResults: Math.min(limit, QUERY_LIMITS.impact.maxResults) });
      if (!r.ok) continue;
      truncated ||= r.data.truncated;
      for (const c of r.data.candidates) if (!changedIds.has(c.id) && !seen.has(c.id)) seen.set(c.id, c);
    }
  };
  // Removed objects are traced in the model they were removed from; everything else in the result.
  run(after, changes.filter((c) => c.change !== "removed" && c.kind !== "project").map((c) => c.id));
  run(before, changes.filter((c) => c.change === "removed").map((c) => c.id));
  const candidates = [...seen.values()].sort((p, q) => p.distance - q.distance || (p.id < q.id ? -1 : 1));

  const modules = new Map<Id, { id: Id; name: string; via: "changed" | "impacted" }>();
  const nameIn = (id: Id) => buildIndex(after).byId.get(id)?.name ?? buildIndex(before).byId.get(id)?.name ?? id;
  for (const c of changes) if (c.moduleId) modules.set(c.moduleId, { id: c.moduleId, name: nameIn(c.moduleId), via: "changed" });
  for (const c of candidates) if (c.moduleId && !modules.has(c.moduleId)) modules.set(c.moduleId, { id: c.moduleId, name: nameIn(c.moduleId), via: "impacted" });

  const contracts = new Map<Id, { id: Id; name: string; moduleId: Id | null; via: "changed" | "impacted" }>();
  for (const c of changes) if (c.kind === "contract") contracts.set(c.id, { id: c.id, name: c.name, moduleId: c.moduleId, via: "changed" });
  for (const c of candidates) if (c.kind === "contract" && !contracts.has(c.id)) contracts.set(c.id, { id: c.id, name: c.name, moduleId: c.moduleId ?? null, via: "impacted" });

  return {
    modules: [...modules.values()].sort((p, q) => (p.id < q.id ? -1 : 1)),
    crossModule: modules.size > 1 ? "yes" : truncated || candidates.length > limit ? "not-determined" : "no",
    contracts: [...contracts.values()].sort((p, q) => (p.id < q.id ? -1 : 1)),
    candidates: candidates.slice(0, limit),
    total: candidates.length,
    truncated: truncated || candidates.length > limit,
    impactClass: "structural-candidate",
    note: "Structural candidates from declared model references (@vcv/query analyzeImpact), not proof of semantic or code impact. Confirm each in the repository.",
  };
}

/** The checkout's claim files and a key for exactly this set (IDs and digests). */
export function readClaims(root: string): { entries: ClaimEntry[]; key: string } {
  try {
    const entries = listBindings(root);
    return { entries, key: canonicalJson(entries.map((e) => [e.bindingId, e.digest])) };
  } catch (e) {
    // An unsafe or unreadable bindings directory is reported by vcv evidence, not here.
    return { entries: [], key: `unreadable:${(e as Error).message}` };
  }
}

export function bindingsFor(entries: ClaimEntry[], changes: ObjectChange[], candidates: ImpactCandidate[]): ProposalPreview["bindings"]["items"] {
  const why = new Map<Id, "changed" | "removed" | "impacted">();
  for (const c of changes) why.set(c.id, c.change === "removed" ? "removed" : "changed");
  for (const c of candidates) if (!why.has(c.id)) why.set(c.id, "impacted");
  const out: ProposalPreview["bindings"]["items"] = [];
  for (const e of entries) {
    const c = e.claim;
    const w = c && why.get(c.modelObjectId);
    if (c && w) out.push({ bindingId: e.bindingId, modelObjectId: c.modelObjectId, relation: c.relation, locator: formatLocator(c.locator), why: w });
  }
  return out;
}

/** One line per operation, for people. */
export function describeOperation(op: ProposedModelChange["operations"][number]): string {
  switch (op.type) {
    case "createModule":
      return `create module ${op.module.id} "${op.module.name}"`;
    case "createEvent":
      return `create event ${op.event.id} "${op.event.name}" owned by ${String(op.event.owner)}`;
    case "createCapability":
      return `create capability ${op.capability.id} "${op.capability.name}" owned by ${String(op.capability.owner)}`;
    case "createRule":
      return `create rule ${op.rule.id} owned by ${String(op.rule.owner)}`;
    case "addDataAttribute":
      return `add attribute ${op.attribute.id} (${op.attribute.name}: ${op.attribute.type}) to ${op.dataId}`;
    case "addState":
      return `add state ${op.state.id} "${op.state.name}" to ${op.behaviorId}`;
    case "addTransition":
      return `add transition ${op.transition.id} to ${op.behaviorId}`;
    case "renameObject":
      return `rename ${op.objectId} to "${op.name}"`;
    case "renameState":
      return `rename state ${op.stateId} of ${op.behaviorId} to "${op.name}"`;
    case "linkContract":
      return `module ${op.moduleId} consumes contract ${op.contractId}`;
    case "setModuleDependencies":
      return `module ${op.moduleId} depends on [${op.dependsOn.join(", ")}]`;
    case "removeObject":
      return `remove ${op.objectId}`;
    case "setRuleStatement":
      return `change the statement of rule ${op.ruleId}`;
    case "setDescription":
      return `change the description of ${op.objectId}`;
    case "createCriterion":
      return `create ${op.criterion.verification} criterion ${op.criterion.id} on ${op.criterion.verifies.map(String).join(", ")}`;
    case "reviseCriterion": {
      const what = [op.statement !== undefined && "its statement", op.verifies !== undefined && `what it verifies (${op.verifies.join(", ")})`, op.verification !== undefined && `its verification policy (${op.verification})`].filter(Boolean);
      return `change ${what.join(", ")} of criterion ${op.criterionId}`;
    }
    case "approveDraft":
      return "mark the model snapshot approved (draft → approved)";
  }
}

// ---- plumbing --------------------------------------------------------------------------

function contextOf(status: ProjectStatus, model: Model): ProposalContext {
  return {
    projectId: model.project.id,
    modelRevision: model.project.modelRevision,
    snapshotStatus: model.project.status,
    source: "model-proposals",
    implementationChecked: false,
    observed: { commit: status.git?.commit ?? null, branch: status.git?.branch ?? null, dirty: status.git?.dirty ?? null },
  };
}

/** Test hook: called after everything was read and before the consistency recheck. */
export type ProposalHooks = { afterRead?: () => void };

/**
 * One observation of the checkout (review of PR #18): the project status, the model and history
 * it names, and the change records, read once. Everything a result reports comes from this one
 * observation, and before returning, the store fingerprint, the Git commit and the change records
 * (and, for previews, the claim files) are read again; if any moved (a checkout, a record rewrite),
 * the call fails with STATE_CHANGED instead of mixing two generations. No locks, no writes.
 */
export type Observation = {
  status: ProjectStatus;
  model: Model;
  history: string[];
  reader: FileStoreReader;
  records: ChangeRecordEntry[];
  store: string;
  commit: string | null;
  recordsKey: string;
};

const recordsKeyOf = (records: ChangeRecordEntry[]) => createHash("sha256").update(canonicalJson(records)).digest("hex");
const commitOf = (status: ProjectStatus) => (status.git ? headCommit(status.root) : null);

export function observed<T>(path: string, hooks: ProposalHooks, body: (obs: Observation) => ProposalResult<T>): ProposalResult<T> {
  const status = projectStatus(path);
  if (status.state !== "ready" || !status.model) return notReady(status);
  let obs: Observation;
  try {
    const store = storeFingerprint(status.storeDir);
    const reader = new FileStoreReader(status.storeDir);
    const model = reader.current();
    const history = reader.revisions();
    const records = listChangeRecords(status.storeDir);
    obs = { status, model, history, reader, records, store, commit: status.git?.commit ?? null, recordsKey: recordsKeyOf(records) };
    if (model.project.modelRevision !== status.model.revision) return changed(obs);
  } catch (e) {
    return { ok: false, error: { code: "STORE_ERROR", message: `the model store could not be read: ${(e as Error).message}` } };
  }
  return body(obs);
}

/** Whether the checkout is still exactly as observed. Read-only. */
function unchanged(obs: Observation, hooks: ProposalHooks, extra?: { key: string; again: () => string }): boolean {
  hooks.afterRead?.();
  try {
    return (
      storeFingerprint(obs.status.storeDir) === obs.store &&
      commitOf(obs.status) === obs.commit &&
      recordsKeyOf(listChangeRecords(obs.status.storeDir)) === obs.recordsKey &&
      (!extra || extra.again() === extra.key)
    );
  } catch {
    return false;
  }
}

function changed<T>(obs: Observation): ProposalResult<T> {
  return {
    ok: false,
    error: {
      code: "STATE_CHANGED",
      message: `the checkout changed while it was read (a Git checkout, or an edit of .vcv/, of binding claims or of the observed source files); nothing was mixed, retry the call`,
    },
    context: contextOf(obs.status, obs.model),
  } as ProposalResult<T>;
}

export function finish<T>(obs: Observation, hooks: ProposalHooks, data: T, extra?: { key: string; again: () => string }): ProposalResult<T> {
  if (!unchanged(obs, hooks, extra)) return changed(obs);
  return { ok: true, context: contextOf(obs.status, obs.model), data };
}

/** An error about what was observed (e.g. UNKNOWN_CHANGE), still only if the observation held. */
export function failFinal<T>(error: ProposalError, obs: Observation, hooks: ProposalHooks): ProposalResult<T> {
  if (!unchanged(obs, hooks)) return changed(obs);
  return { ok: false, context: contextOf(obs.status, obs.model), error };
}

function okWith<T>(status: ProjectStatus, model: Model, data: T): ProposalResult<T> {
  return { ok: true, context: contextOf(status, model), data };
}

function notReady<T>(status: ProjectStatus): ProposalResult<T> {
  const why = status.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ");
  return { ok: false, error: { code: "PROJECT_NOT_READY", message: `the VCV project is ${status.state}${why ? `: ${why}` : ""}` } };
}

function invalid<T>(error: z.ZodError): ProposalResult<T> {
  return {
    ok: false,
    error: { code: "INVALID_REQUEST", message: "request does not match the input schema", details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
  };
}

/** The read-only half, bound to one checkout, for adapters that serve it (MCP --repo). */
export type ProposalReadApi = {
  listProposals(req?: ListProposalsRequest): ProposalResult<ProposalList>;
  previewProposal(req: PreviewProposalRequest): ProposalResult<ProposalPreview>;
};

export function createProposalReadApi(path: string, hooks: ProposalHooks = {}): ProposalReadApi {
  return { listProposals: (req) => listProposals(path, req, hooks), previewProposal: (req) => previewProposal(path, req, hooks) };
}
