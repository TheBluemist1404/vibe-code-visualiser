// Agent-accessible model proposals and the pre-approval review surface. Design notes: docs/proposals.md.
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
//     agent's implementation report is a separate claim read with `vcv implementation show`).
//
// Previews and listings never write anything, not even store recovery (FileStoreReader).
import { z } from "zod";
import { persistedIdProblem } from "@vcv/ir";
import type { Diagnostic, Id, Model } from "@vcv/ir";
import {
  FileStore,
  FileStoreReader,
  ModelEngine,
  applyOperations,
  canonicalJson,
  checkChange,
  proposalDigest,
  proposedChangeSchema,
} from "@vcv/core";
import type { ChangeRecord, ChangeStatus, HostContext, ImplementationRequest, ProposedModelChange } from "@vcv/core";
import type { ImpactCandidate } from "@vcv/query";
import type { ClaimEntry } from "../bindings/bindings.ts";
import { formatLocator } from "../bindings/locator.ts";
import { projectStatus } from "../project.ts";
import { invalidRequest, notReady, okWith } from "../shared/result.ts";
import type { RepoResult } from "../shared/result.ts";
import { failFinal, finish, observed, readRevision } from "../shared/observation.ts";
import type { ObserveHooks } from "../shared/observation.ts";
import { DIFF_LIMITS, describeOperation, diffModels, impactOf } from "../shared/model-diff.ts";
import type { ModelImpact, ObjectChange } from "../shared/model-diff.ts";
import { readClaims } from "../shared/claims.ts";

export const PROPOSAL_LIMITS = {
  /** Operations per proposal accepted by this surface. */
  maxOperations: 100,
  /** Canonical JSON size of one proposal accepted by this surface. */
  maxBytes: 256 * 1024,
  list: { default: 50, max: 200 },
  /** Object changes, impact candidates and binding claims listed per preview. */
  items: { default: 50, max: 200 },
  /** Characters of one before/after field value shown in a preview. */
  valueChars: DIFF_LIMITS.valueChars,
} as const;

// ---- requests --------------------------------------------------------------------------

const persistedId = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => persistedIdProblem(v) === undefined, {
    message: "must use the persisted-ID grammar (lowercase letters, digits, '.', '-', '_')",
  });

export const listProposalsRequest = z
  .object({
    lifecycles: z
      .array(z.enum(["pending", "stale", "rejected", "applied", "invalid"]))
      .min(1)
      .max(5)
      .optional(),
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
  .refine((r) => (r.changeId === undefined) !== (r.change === undefined), {
    message: "pass exactly one of changeId or change",
  });

export type ListProposalsRequest = z.input<typeof listProposalsRequest>;
export type PreviewProposalRequest = z.input<typeof previewProposalRequest>;

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
 * What the change record says about how it was applied, never who really decided (trusted review adds the
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

export type ProposalList = {
  proposals: ProposalSummary[];
  total: number;
  matched: number;
  truncated: boolean;
  counts: Record<ProposalLifecycle, number>;
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
  delta: {
    against: "current" | "base";
    revision: string;
    changes: ObjectChange[];
    total: number;
    truncated: boolean;
  } | null;
  impact: ModelImpact | null;
  /** Binding claims about changed, removed or impacted objects: code that probably has to move with this change. */
  bindings: {
    items: {
      bindingId: string;
      modelObjectId: Id;
      relation: string;
      locator: string;
      why: "changed" | "removed" | "impacted";
    }[];
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
  SCHEMA:
    "The proposal does not match the typed change schema: fix the field at `path` (see docs/proposals.md for the operations and their parameters).",
  NOT_AUTHORIZED: "This host may not propose model changes; ask the person running VCV for model:propose.",
  DUPLICATE_CHANGE:
    "Change IDs are immutable and used once: choose a new changeId (the existing record is left as it was).",
  WRONG_PROJECT: "Set projectId to the project's ID (vcv project status or vcv_get_project_overview).",
  STALE_REVISION:
    "The model moved since you read it: re-read the current revision, re-check your operations against it, and submit a new proposal with that expectedRevision.",
  ID_IN_USE: "Pick an ID that does not exist yet (vcv_search_objects / vcv query search).",
  TARGET_MISSING:
    "The operation names an object that does not exist at the base revision; check the ID with vcv_get_context.",
  REFERENCED:
    "Remove or redirect the references listed first (in an earlier operation of the same proposal), then remove the object.",
  HAS_OWNED_OBJECTS: "Remove or move the owned objects first, in earlier operations of the same proposal.",
  TOO_LARGE: `Split the change: this surface accepts at most ${PROPOSAL_LIMITS.maxOperations} operations and ${PROPOSAL_LIMITS.maxBytes} bytes per proposal.`,
  HEAD_CHANGED:
    "The model store moved while the proposal was being recorded (e.g. a Git checkout); nothing was written. Re-read and submit again.",
  STORE_CHANGED:
    "The model store changed while the proposal was being recorded; nothing was written. Re-read and submit again.",
  UNKNOWN_REF:
    "A reference points at an ID that does not exist after the change; create the target in an earlier operation of the same proposal or fix the ID.",
  WRONG_KIND: "A reference points at an object of the wrong kind; check the target's kind with vcv_get_context.",
  DEPENDENCY_CYCLE:
    "The module dependencies would form a cycle; change setModuleDependencies so the graph stays acyclic.",
  UNRESOLVED_IN_APPROVED:
    "An approved snapshot may not hold unresolved placeholders; resolve them in this proposal, or leave the snapshot a draft.",
  UNRESOLVED_REF:
    "A reference points at an ID that does not exist after the change; add the target in an earlier operation or fix the ID.",
};

function hinted(ds: readonly Diagnostic[]): HintedDiagnostic[] {
  return ds.map((d) => (HINTS[d.code] ? { ...d, hint: HINTS[d.code] } : { ...d }));
}

const NOT_IMPLEMENTED =
  "VCV never infers implementation. Approving a change approves intent only; code, tests and binding claims are separate work and separate evidence. An implementing agent's report (vcv implementation record) is a separate, unverified claim and is not shown here.";

// ---- submit ----------------------------------------------------------------------------

/**
 * Submit a typed model change for review. Proposal-only: the host's permissions are narrowed to
 * model:propose, so the engine can only record it as pending (or rejected), whatever else the
 * caller may hold. Throws only when the project cannot be opened (StoreError) or on a bug.
 */
export function submitProposal(path: string, input: unknown, host: HostContext): RepoResult<SubmitResult> {
  const status = projectStatus(path);
  if (status.state !== "ready" || !status.model) return notReady(status);
  const before = status.model.revision;
  const size = sizeProblem(input);
  const ctx: HostContext = {
    principalId: host.principalId,
    permissions: host.permissions.filter((p) => p === "model:propose"),
  };
  const engine = new ModelEngine(new FileStore(status.storeDir));
  if (size && ctx.permissions.length) {
    const claimed =
      typeof (input as { changeId?: unknown })?.changeId === "string" ? (input as { changeId: string }).changeId : null;
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
  const existing =
    typeof (input as { changeId?: unknown })?.changeId === "string" &&
    !persistedIdProblem((input as { changeId: string }).changeId)
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
    return {
      path: "operations",
      message: `${ops.length} operations; this surface accepts at most ${PROPOSAL_LIMITS.maxOperations}`,
    };
  }
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(canonicalJson(input ?? null));
  } catch {
    return { path: "", message: "proposal is not plain data" };
  }
  return bytes > PROPOSAL_LIMITS.maxBytes
    ? { path: "", message: `${bytes} bytes; this surface accepts at most ${PROPOSAL_LIMITS.maxBytes}` }
    : undefined;
}

// ---- list ------------------------------------------------------------------------------

/** Every proposal recorded in this checkout with its derived lifecycle. Read-only. */
export function listProposals(path: string, input: unknown = {}, hooks: ObserveHooks = {}): RepoResult<ProposalList> {
  const parsed = listProposalsRequest.safeParse(input ?? {});
  if (!parsed.success) return invalidRequest(parsed.error);
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

function lifecycleOf(
  r: ChangeRecord,
  model: Model,
  history: readonly string[],
): Pick<ProposalSummary, "lifecycle" | "stale" | "resultInThisCheckout"> {
  switch (r.status) {
    case "applied":
      return {
        lifecycle: "applied",
        resultInThisCheckout: !!r.resultingRevision && history.includes(r.resultingRevision),
      };
    case "pending": {
      const current = model.project.modelRevision;
      if (r.baseRevision === current) return { lifecycle: "pending" };
      return {
        lifecycle: "stale",
        stale: history.includes(r.baseRevision)
          ? { reason: "superseded", detail: `based on ${r.baseRevision}; this checkout has moved on to ${current}` }
          : {
              reason: "other-line",
              detail: `based on ${r.baseRevision}, which is not in this checkout's history (another branch?)`,
            },
      };
    }
    default:
      return { lifecycle: "rejected" };
  }
}

function summarize(
  changeId: string,
  r: ChangeRecord | undefined,
  problem: string | undefined,
  model: Model,
  history: readonly string[],
): ProposalSummary {
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
export function previewProposal(path: string, input: unknown, hooks: ObserveHooks = {}): RepoResult<ProposalPreview> {
  const parsed = previewProposalRequest.safeParse(input ?? {});
  if (!parsed.success) return invalidRequest(parsed.error);
  const req = parsed.data;
  return observed(path, hooks, (obs) => {
    const { model, history, reader } = obs;
    let change: ProposedModelChange;
    let record: ChangeRecord | undefined;
    if (req.changeId !== undefined) {
      const entry = obs.records.find((e) => e.changeId === req.changeId);
      if (!entry)
        return failFinal(
          { code: "UNKNOWN_CHANGE", message: `no change record "${req.changeId}" in this checkout` },
          obs,
          hooks,
        );
      const c = entry.record ? proposedChangeSchema.safeParse(entry.record.change) : undefined;
      if (!entry.record || !c?.success) {
        return failFinal(
          {
            code: "INVALID_RECORD",
            message: `change record "${req.changeId}" is unreadable: ${entry.problem ?? "its change does not match the typed change schema"}`,
          },
          obs,
          hooks,
        );
      }
      record = entry.record;
      change = c.data;
    } else {
      const size = sizeProblem(req.change);
      if (size)
        return failFinal(
          {
            code: "INVALID_REQUEST",
            message: `change is too large: ${size.message}`,
            details: [{ path: `change.${size.path}`, message: HINTS.TOO_LARGE! }],
          },
          obs,
          hooks,
        );
      change = req.change!;
    }

    const lifecycle: ProposalLifecycle | "unsubmitted" = record
      ? lifecycleOf(record, model, history).lifecycle
      : "unsubmitted";
    const check = checkChange(change, model);

    // The delta: against the current revision if the operations apply there, otherwise against
    // the base revision when that is an earlier revision of this line.
    let delta: { against: "current" | "base"; before: Model; after: Model } | null = null;
    if (check.model) delta = { against: "current", before: model, after: check.model };
    else if (
      change.expectedRevision !== model.project.modelRevision &&
      history.includes(change.expectedRevision) &&
      change.projectId === model.project.id
    ) {
      const base = readRevision(reader, change.expectedRevision);
      const applied = base && applyOperations(base, change.operations);
      if (base && applied && "model" in applied) delta = { against: "base", before: base, after: applied.model };
    }

    const limit = req.limit;
    const changes = delta ? diffModels(delta.before, delta.after) : [];
    const impact = delta ? impactOf(delta.before, delta.after, changes, limit) : null;
    const claims = readClaims(obs.status.root);
    const bindingItems = bindingsFor(claims.entries, changes, impact?.candidates ?? []);

    return finish(
      obs,
      hooks,
      {
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
          ? {
              against: delta.against,
              revision: delta.before.project.modelRevision,
              changes: changes.slice(0, limit),
              total: changes.length,
              truncated: changes.length > limit,
            }
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
      },
      { key: claims.key, again: () => readClaims(obs.status.root).key },
    );
  });
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
  if (record)
    out.push(
      `The proposer identity "${record.proposerId}" is what the host asserted when the proposal was submitted; see docs/proposals.md for what that proves locally.`,
    );
  if (!change.rationale) out.push("The proposal carries no rationale: ask the proposer what request it implements.");
  if (!change.implementation)
    out.push(
      "The proposal states no implementation request (behavior, acceptance criteria, scope): the implementation handoff will have none to give the coding agent.",
    );
  else if (!change.implementation.scope)
    out.push("The implementation request declares no code scope: every changed file will be reported as unscoped.");
  if (lifecycle === "stale")
    out.push(
      "This proposal is stale: the delta shown is against its base revision, and an approval would fail. It needs a new proposal against the current revision.",
    );
  if (impact?.crossModule === "not-determined")
    out.push(
      "Whether the change reaches other modules is not determined: the impact list was cut before all candidates were seen.",
    );
  if (impact?.crossModule === "yes")
    out.push(
      "The change reaches more than one module: check each module's contracts and binding claims, not only the module that was asked about.",
    );
  if (impact?.truncated)
    out.push("The impact list was cut by its budget: more objects may be affected than are listed.");
  if (bindings === 0)
    out.push(
      "No binding claims point at the changed or impacted objects, so the code they correspond to is not known to VCV.",
    );
  return out;
}

export function bindingsFor(
  entries: ClaimEntry[],
  changes: ObjectChange[],
  candidates: ImpactCandidate[],
): ProposalPreview["bindings"]["items"] {
  const why = new Map<Id, "changed" | "removed" | "impacted">();
  for (const c of changes) why.set(c.id, c.change === "removed" ? "removed" : "changed");
  for (const c of candidates) if (!why.has(c.id)) why.set(c.id, "impacted");
  const out: ProposalPreview["bindings"]["items"] = [];
  for (const e of entries) {
    const c = e.claim;
    const w = c && why.get(c.modelObjectId);
    if (c && w)
      out.push({
        bindingId: e.bindingId,
        modelObjectId: c.modelObjectId,
        relation: c.relation,
        locator: formatLocator(c.locator),
        why: w,
      });
  }
  return out;
}

/** The read-only half, bound to one checkout, for adapters that serve it (MCP --repo). */
export type ProposalReadApi = {
  listProposals(req?: ListProposalsRequest): RepoResult<ProposalList>;
  previewProposal(req: PreviewProposalRequest): RepoResult<ProposalPreview>;
};

export function createProposalReadApi(path: string, hooks: ObserveHooks = {}): ProposalReadApi {
  return {
    listProposals: (req) => listProposals(path, req, hooks),
    previewProposal: (req) => previewProposal(path, req, hooks),
  };
}
