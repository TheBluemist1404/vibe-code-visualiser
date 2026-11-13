// The model engine (IR v0.2 §6–7). Every write surface (CLI, canvas, MCP) calls propose()
// and approve(); none of them may change the model any other way.
import { hasErrors, persistedIdProblem, validateModel } from "@vcv/ir";
import type { Diagnostic, Model } from "@vcv/ir";
import { applyOperations, proposedChangeSchema } from "./operations.ts";
import type { ProposedModelChange } from "./operations.ts";
import { StoreError } from "./store/files.ts";
import type { ChangeGuard, ModelStore, StoreSnapshot } from "./store/model-store.ts";
import { canonicalJson, sha256Hex } from "./digest.ts";
import { branchSafeRevisionId } from "./revisions.ts";

/** Supplied by the trusted host (session, OAuth token, local user), never by the caller's payload. */
export type HostContext = {
  principalId: string;
  permissions: readonly Permission[];
};

export type Permission =
  /** May submit proposals. */
  | "model:propose"
  /** May apply a valid proposal without a separate approval. */
  | "model:apply"
  /** May approve someone else's pending proposal, and approve drafts. */
  | "model:approve"
  /** May record, reassert or remove source binding claims (ADR 0007 §5). Never changes the model. */
  | "binding:record"
  /** May mark a binding claim as disputed. */
  | "binding:dispute"
  /** May record test runs as host-observed (M4.3): the host itself ran the tests and read the report. Without it a run is agent-claimed. */
  | "tests:observe";

export type ChangeStatus = "pending" | "applied" | "rejected" | "denied";

/** External engine/audit record (§7): the current state of one proposal. Not canonical IR. */
export type ChangeRecord = {
  changeId: string;
  projectId: string;
  proposerId: string;
  status: ChangeStatus;
  baseRevision: string;
  approverId?: string;
  resultingRevision?: string;
  validationResults: Diagnostic[];
  change: ProposedModelChange;
};

/** One line of the append-only attempt log. Written for every propose/approve call. */
export type AuditEvent = {
  at: string;
  action: "propose" | "approve";
  principalId: string;
  changeId?: string;
  status: ChangeStatus;
  codes: string[];
  resultingRevision?: string;
};

/** What a propose/approve call did. `record` is the persisted state, when one exists. */
export type Outcome = {
  status: ChangeStatus;
  changeId?: string;
  diagnostics: Diagnostic[];
  record?: ChangeRecord;
};

export type ApproveOptions = {
  /** The proposalDigest the reviewer reviewed; approval is refused if the record's content differs. */
  expectedDigest?: string;
};

export type EnginePolicy = {
  /** Whether a pending change may be approved by the principal who proposed it. Default false. */
  allowSelfApproval?: boolean;
  /** Clock for audit timestamps (injectable for tests). */
  now?: () => Date;
};

/**
 * Audit policy (docs/adr/0004-audit.md):
 * - A ChangeRecord is persisted only for a well-formed proposal from a principal allowed to
 *   propose, with a change ID not used before. Its state is then applied, pending or rejected,
 *   and later approvals update it.
 * - Every call, including denied, malformed and replayed proposals and every approval
 *   attempt, appends an AuditEvent. Those attempts never create or alter ChangeRecords, so an
 *   unauthorized caller cannot claim a change ID or disturb a pending proposal.
 */
export class ModelEngine {
  private readonly store: ModelStore;
  private readonly policy: EnginePolicy;

  constructor(store: ModelStore, policy: EnginePolicy = {}) {
    this.store = store;
    this.policy = policy;
  }

  current(): Model {
    return this.store.current();
  }

  record(changeId: string): ChangeRecord | undefined {
    return persistedIdProblem(changeId) ? undefined : this.store.getChange(changeId);
  }

  audit(): AuditEvent[] {
    return this.store.audit();
  }

  /**
   * Validate a proposed change against the current revision and either apply it as one
   * new revision, queue it for approval, reject it, or deny it. Never partially applies.
   */
  propose(input: unknown, ctx: HostContext): Outcome {
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const claimedId = typeof raw.changeId === "string" ? raw.changeId : undefined;

    if (!ctx.permissions.includes("model:propose")) {
      return this.log("propose", ctx, {
        status: "denied",
        changeId: claimedId,
        diagnostics: [diag("NOT_AUTHORIZED", "", `${ctx.principalId} may not propose changes`)],
      });
    }
    const parsed = proposedChangeSchema.safeParse(input);
    if (!parsed.success) {
      const diagnostics = parsed.error.issues.map((i) => diag("SCHEMA", i.path.join("."), i.message));
      return this.log("propose", ctx, { status: "rejected", changeId: claimedId, diagnostics });
    }
    const change = parsed.data;
    // Take the snapshot first and decide everything (replay check, validation, the write) on it,
    // so no decision is made on a checkout that is gone by the time of the write.
    const snap = this.store.snapshot();
    const existing = this.store.getChange(change.changeId);
    if (existing) {
      // Replays never overwrite the original record.
      return this.log("propose", ctx, {
        status: "rejected",
        changeId: change.changeId,
        diagnostics: [diag("DUPLICATE_CHANGE", "changeId", `change "${change.changeId}" was already submitted`)],
        record: existing,
      });
    }

    const record: ChangeRecord = {
      changeId: change.changeId,
      projectId: change.projectId,
      proposerId: ctx.principalId,
      baseRevision: change.expectedRevision,
      status: "pending",
      validationResults: [],
      change,
    };
    // Validate and commit against that snapshot: the store refuses the write if anything moved
    // in between (a Git checkout, a merge, another writer), so a validated model is never
    // retargeted onto a different line.
    const check = this.dryRun(change, snap.model);
    // Every record write is guarded by the same snapshot: a new record may only be created where
    // none exists, in the store state it was validated against.
    const fresh = { token: snap.token, previous: null };
    if (check.errors.length)
      return this.log(
        "propose",
        ctx,
        this.save({ ...record, status: "rejected", validationResults: check.errors }, fresh),
      );
    record.validationResults = check.warnings;

    const needsApproval =
      !ctx.permissions.includes("model:apply") ||
      (change.operations.some((o) => o.type === "approveDraft") && !ctx.permissions.includes("model:approve"));
    if (needsApproval) return this.log("propose", ctx, this.save(record, fresh));
    return this.log("propose", ctx, this.commit(record, check.model!, snap, null));
  }

  /**
   * Approve a pending change. Unauthorized or self-approval attempts are denied and leave the
   * proposal pending. Authorized approvals revalidate against the current revision first.
   */
  approve(changeId: string, ctx: HostContext, opts: ApproveOptions = {}): Outcome {
    const idProblem = persistedIdProblem(changeId);
    if (idProblem) {
      return this.log("approve", ctx, {
        status: "rejected",
        changeId,
        diagnostics: [diag("INVALID_ID", "changeId", `change id ${idProblem}`)],
      });
    }
    const snap = this.store.snapshot();
    const record = this.store.getChange(changeId);
    if (!record) {
      return this.log("approve", ctx, {
        status: "rejected",
        changeId,
        diagnostics: [diag("UNKNOWN_CHANGE", "changeId", `no change "${changeId}"`)],
      });
    }
    if (record.status !== "pending") {
      return this.log("approve", ctx, {
        status: "rejected",
        changeId,
        diagnostics: [diag("NOT_PENDING", "", `change is ${record.status}`)],
        record,
      });
    }
    if (!ctx.permissions.includes("model:approve")) {
      return this.log("approve", ctx, {
        status: "denied",
        changeId,
        diagnostics: [diag("NOT_AUTHORIZED", "", `${ctx.principalId} may not approve changes`)],
        record,
      });
    }
    if (ctx.principalId === record.proposerId && !this.policy.allowSelfApproval) {
      return this.log("approve", ctx, {
        status: "denied",
        changeId,
        diagnostics: [diag("SELF_APPROVAL", "", "a proposer cannot approve their own change")],
        record,
      });
    }
    // M3.2: bind the decision to the content the reviewer saw. A record edited after the preview
    // no longer matches; nothing is changed and the proposal stays pending.
    if (opts.expectedDigest !== undefined && opts.expectedDigest !== proposalDigest(record.change)) {
      return this.log("approve", ctx, {
        status: "rejected",
        changeId,
        diagnostics: [
          diag(
            "DIGEST_MISMATCH",
            "",
            `the proposal's content digest is ${proposalDigest(record.change)}, not the reviewed ${opts.expectedDigest}; preview it again`,
          ),
        ],
        record,
      });
    }
    const check = this.dryRun(record.change, snap.model);
    if (check.errors.length) {
      return this.log(
        "approve",
        ctx,
        this.save(
          { ...record, approverId: ctx.principalId, status: "rejected", validationResults: check.errors },
          { token: snap.token, previous: record },
        ),
      );
    }
    return this.log(
      "approve",
      ctx,
      this.commit(
        { ...record, approverId: ctx.principalId, validationResults: check.warnings },
        check.model!,
        snap,
        record,
      ),
    );
  }

  private dryRun(change: ProposedModelChange, current: Model): ChangeCheck {
    return checkChange(change, current);
  }

  private commit(record: ChangeRecord, model: Model, snap: StoreSnapshot, previous: ChangeRecord | null): Outcome {
    // Branch-safe identity (ADR 0007): the parent is the revision the change was validated
    // against, and the digest covers the new content, so two Git branches never mint the same ID
    // for different models.
    const parent = model.project.modelRevision;
    const next = branchSafeRevisionId(model, parent, snap.history.length + 1);
    model.project.modelRevision = next;
    const done: ChangeRecord = { ...record, status: "applied", resultingRevision: next };
    try {
      this.store.commit(model, done, { token: snap.token, previous });
    } catch (e) {
      // The store moved after validation. Nothing was written and no record is created or
      // changed (a pending proposal stays pending); the caller re-reads and retries.
      if (e instanceof StoreError && (e.code === "HEAD_CHANGED" || e.code === "STORE_CHANGED")) {
        return { status: "rejected", changeId: record.changeId, diagnostics: [diag(e.code, "", e.message)] };
      }
      throw e;
    }
    return { status: "applied", changeId: done.changeId, diagnostics: done.validationResults, record: done };
  }

  private save(record: ChangeRecord, guard: ChangeGuard): Outcome {
    try {
      this.store.putChange(record, guard);
    } catch (e) {
      // The store moved since validation: persist nothing (the attempt is still audited).
      if (e instanceof StoreError && e.code === "STORE_CHANGED") {
        return { status: "rejected", changeId: record.changeId, diagnostics: [diag(e.code, "", e.message)] };
      }
      throw e;
    }
    return { status: record.status, changeId: record.changeId, diagnostics: record.validationResults, record };
  }

  private log(action: AuditEvent["action"], ctx: HostContext, outcome: Outcome): Outcome {
    this.store.appendAudit({
      at: (this.policy.now?.() ?? new Date()).toISOString(),
      action,
      principalId: ctx.principalId,
      ...(outcome.changeId !== undefined ? { changeId: outcome.changeId } : {}),
      status: outcome.status,
      codes: outcome.diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
      ...(outcome.status === "applied" && outcome.record?.resultingRevision
        ? { resultingRevision: outcome.record.resultingRevision }
        : {}),
    });
    return outcome;
  }
}

export type ChangeCheck = { model?: Model; errors: Diagnostic[]; warnings: Diagnostic[] };

/**
 * The engine's own validation of a well-formed change against one model state, without writing
 * anything: project, expected revision, the typed operations in order, then whole-model
 * validation. propose() and approve() decide on exactly this; read-only previews (M3.1) call it
 * too, so a preview can never disagree with what an approval would check.
 */
export function checkChange(change: ProposedModelChange, current: Model): ChangeCheck {
  if (change.projectId !== current.project.id) {
    return {
      errors: [
        diag(
          "WRONG_PROJECT",
          "projectId",
          `change targets "${change.projectId}", engine holds "${current.project.id}"`,
        ),
      ],
      warnings: [],
    };
  }
  if (change.expectedRevision !== current.project.modelRevision) {
    return {
      errors: [
        diag(
          "STALE_REVISION",
          "expectedRevision",
          `expected ${change.expectedRevision}, current is ${current.project.modelRevision}`,
        ),
      ],
      warnings: [],
    };
  }
  const applied = applyOperations(current, change.operations);
  if ("error" in applied) return { errors: [applied.error], warnings: [] };
  const results = validateModel(applied.model);
  return hasErrors(results)
    ? { errors: results.filter((d) => d.severity === "error"), warnings: [] }
    : { model: applied.model, errors: [], warnings: results };
}

/**
 * Content identity of a proposal (M3.1): sha256 over the canonical JSON of the change exactly as
 * submitted (change ID, project, expected revision, operations, rationale). Derived, never stored:
 * whoever previews a proposal sees this digest, and an approval can be bound to it, so a record
 * edited after the preview no longer matches what was reviewed.
 */
export function proposalDigest(change: ProposedModelChange): string {
  return sha256Hex(`vcv-proposal-v1\0${canonicalJson(change)}`);
}

/**
 * The pre-M2 sequential scheme (rev-1 → rev-2). No longer used for new commits because two
 * Git branches would both produce rev-2; kept for callers and tests that relied on it.
 * @deprecated use branchSafeRevisionId
 */
export function nextRevision(rev: string): string {
  const m = /^(.*?)(\d+)$/.exec(rev);
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${rev}-1`;
}

const diag = (code: string, path: string, message: string): Diagnostic => ({ code, severity: "error", path, message });
