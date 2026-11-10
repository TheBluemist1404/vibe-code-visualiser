// The model engine (IR v0.2 §6–7). Every write surface (CLI, canvas, MCP) calls propose()
// and approve(); none of them may change the model any other way.
import { hasErrors, validateModel } from "@vcv/ir";
import type { Diagnostic, Model } from "@vcv/ir";
import { applyOperations, proposedChangeSchema } from "./operations.ts";
import type { ProposedModelChange } from "./operations.ts";
import type { ModelStore } from "./store.ts";

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
  | "model:approve";

export type ChangeStatus = "pending" | "applied" | "rejected" | "denied";

/** External engine/audit record (§7). Not part of the canonical IR. */
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

export type EnginePolicy = {
  /** Whether a pending change may be approved by the principal who proposed it. Default false. */
  allowSelfApproval?: boolean;
};

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
    return this.store.getChange(changeId);
  }

  /**
   * Validate a proposed change against the current revision and either apply it as one
   * new revision, queue it for approval, reject it, or deny it. Never partially applies.
   */
  propose(input: unknown, ctx: HostContext): ChangeRecord {
    const current = this.store.current();
    const parsed = proposedChangeSchema.safeParse(input);
    const raw = (input ?? {}) as Partial<ProposedModelChange>;
    const base = {
      changeId: String(raw.changeId ?? ""),
      projectId: String(raw.projectId ?? ""),
      proposerId: ctx.principalId,
      baseRevision: String(raw.expectedRevision ?? ""),
    };

    if (!ctx.permissions.includes("model:propose")) {
      return this.finish({ ...base, status: "denied", validationResults: [diag("NOT_AUTHORIZED", "", `${ctx.principalId} may not propose changes`)], change: raw as ProposedModelChange }, false);
    }
    if (!parsed.success) {
      const results = parsed.error.issues.map((i) => diag("SCHEMA", i.path.join("."), i.message));
      return this.finish({ ...base, status: "rejected", validationResults: results, change: raw as ProposedModelChange }, false);
    }
    const change = parsed.data;
    if (this.store.getChange(change.changeId)) {
      // Replays never overwrite the original record.
      return { ...base, status: "rejected", validationResults: [diag("DUPLICATE_CHANGE", "changeId", `change "${change.changeId}" was already submitted`)], change };
    }
    const record: ChangeRecord = { ...base, status: "pending", validationResults: [], change };

    const check = this.dryRun(change, current);
    if (check.errors.length) return this.finish({ ...record, status: "rejected", validationResults: check.errors });
    record.validationResults = check.warnings;

    const needsApproval =
      !ctx.permissions.includes("model:apply") ||
      (change.operations.some((o) => o.type === "approveDraft") && !ctx.permissions.includes("model:approve"));
    if (needsApproval) return this.finish(record);
    return this.commit(record, check.model!);
  }

  /** Approve a pending change. Revalidates against the current revision before committing. */
  approve(changeId: string, ctx: HostContext): ChangeRecord {
    const record = this.store.getChange(changeId);
    if (!record) throw new Error(`unknown change "${changeId}"`);
    if (record.status !== "pending") {
      return { ...record, validationResults: [diag("NOT_PENDING", "", `change is ${record.status}`)] };
    }
    if (!ctx.permissions.includes("model:approve")) {
      // An unauthorized approval attempt is denied but leaves the proposal pending for a real approver.
      return { ...record, status: "denied", validationResults: [diag("NOT_AUTHORIZED", "", `${ctx.principalId} may not approve changes`)] };
    }
    if (ctx.principalId === record.proposerId && !this.policy.allowSelfApproval) {
      return { ...record, status: "denied", validationResults: [diag("SELF_APPROVAL", "", "a proposer cannot approve their own change")] };
    }
    const check = this.dryRun(record.change, this.store.current());
    if (check.errors.length) {
      return this.finish({ ...record, approverId: ctx.principalId, status: "rejected", validationResults: check.errors });
    }
    return this.commit({ ...record, validationResults: check.warnings }, check.model!, ctx.principalId);
  }

  private dryRun(change: ProposedModelChange, current: Model): { model?: Model; errors: Diagnostic[]; warnings: Diagnostic[] } {
    if (change.projectId !== current.project.id) {
      return { errors: [diag("WRONG_PROJECT", "projectId", `change targets "${change.projectId}", engine holds "${current.project.id}"`)], warnings: [] };
    }
    if (change.expectedRevision !== current.project.modelRevision) {
      return {
        errors: [diag("STALE_REVISION", "expectedRevision", `expected ${change.expectedRevision}, current is ${current.project.modelRevision}`)],
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

  private commit(record: ChangeRecord, model: Model, approverId?: string): ChangeRecord {
    const next = nextRevision(model.project.modelRevision);
    model.project.modelRevision = next;
    const done: ChangeRecord = { ...record, status: "applied", resultingRevision: next, ...(approverId ? { approverId } : {}) };
    this.store.commit(model, done);
    return done;
  }

  private finish(record: ChangeRecord, persist = true): ChangeRecord {
    if (persist) this.store.putChange(record);
    return record;
  }
}

export function nextRevision(rev: string): string {
  const m = /^(.*?)(\d+)$/.exec(rev);
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${rev}-1`;
}

const diag = (code: string, path: string, message: string): Diagnostic => ({ code, severity: "error", path, message });
