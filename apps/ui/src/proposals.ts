// Staged inspector edits become typed proposals here. The host previews them with the engine
// and records them as pending; it never applies or approves anything. Approval stays the
// reviewer's `vcv review approve` with their own key (docs/approvals.md).
import { randomBytes } from "node:crypto";
import { listProposals, previewProposal, submitProposal } from "@vcv/repo";
import type { ProposalPreview } from "@vcv/repo";
import { toOperations } from "./edits.ts";
import type { ProjectSession } from "./session.ts";
import type { DraftPreview, DraftRequest, ProposalsView, SubmitView } from "./types.ts";

/** The draft was staged on another model than the one the checkout holds now. */
export class StaleDraftError extends Error {
  readonly code = "STALE_DRAFT";
}

/** The repository layer refused the request (not ready, unreadable, invalid request). */
export class ProposalHostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A lowercase change ID that sorts by time and does not collide: ui-20261123-101500-3f9a. */
export function newChangeId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `ui-${stamp}-${randomBytes(2).toString("hex")}`;
}

export class ProposalDesk {
  private readonly session: ProjectSession;
  /** Who proposals are recorded for. The host only ever holds model:propose. */
  readonly proposerId: string;

  constructor(session: ProjectSession, proposerId: string) {
    this.session = session;
    this.proposerId = proposerId;
  }

  /** Dry run: what the draft would change, checked by the engine against the current model. */
  preview(body: Record<string, unknown>): DraftPreview {
    const { change } = this.change(body, "ui-draft");
    return this.dryRun(change);
  }

  /**
   * Record the draft as a pending proposal. A draft that does not apply to the current model is
   * answered with its preview and not submitted, so a stale or invalid draft leaves no record.
   */
  submit(body: Record<string, unknown>): SubmitView {
    const { change, before, root } = this.change(body, newChangeId());
    const preview = this.dryRun(change);
    if (!preview.validation.appliesToCurrent || preview.validation.errors.length) {
      return {
        status: "not-submitted",
        recorded: false,
        changeId: null,
        proposalDigest: null,
        proposerId: this.proposerId,
        modelRevision: { before, after: before },
        diagnostics: preview.validation.errors,
        preview,
        commands: null,
        next: "Nothing was recorded. Fix the staged edits, or restage them on the current model.",
      };
    }
    const r = submitProposal(this.session.path, change, {
      principalId: this.proposerId,
      permissions: ["model:propose"],
    });
    if (!r.ok) throw new ProposalHostError(r.error.code, r.error.message);
    const d = r.data;
    return {
      status: d.status,
      recorded: d.recorded,
      changeId: d.changeId,
      proposalDigest: d.proposalDigest,
      proposerId: this.proposerId,
      modelRevision: d.modelRevision,
      diagnostics: d.diagnostics,
      preview,
      commands:
        d.ok && d.changeId
          ? {
              preview: `vcv proposal preview ${root} ${d.changeId}`,
              approve: `vcv review approve ${root} ${d.changeId} --digest ${d.proposalDigest} --key <your key> --trust-commit <sha>`,
            }
          : null,
      next: d.next,
    };
  }

  /** Proposals waiting for a reviewer in this checkout. */
  pending(): ProposalsView {
    const snap = this.session.ready();
    const r = listProposals(this.session.path, { lifecycles: ["pending", "stale"], limit: 50 });
    if (!r.ok) throw new ProposalHostError(r.error.code, r.error.message);
    return {
      modelKey: snap.key,
      total: r.data.matched,
      proposals: r.data.proposals.map((p) => ({
        changeId: p.changeId,
        lifecycle: p.lifecycle,
        proposerId: p.proposerId,
        baseRevision: p.baseRevision,
        operations: p.operations,
        ...(p.rationale ? { rationale: p.rationale } : {}),
        proposalDigest: p.proposalDigest,
      })),
    };
  }

  /** Build the typed change for a draft, on the model it was staged on. */
  private change(body: Record<string, unknown>, changeId: string) {
    const draft = body as Partial<DraftRequest>;
    if (typeof draft.expectedRevision !== "string" || typeof draft.modelKey !== "string")
      throw new ProposalHostError(
        "INVALID_REQUEST",
        "a draft names the expectedRevision and modelKey it was staged on",
      );
    if (draft.rationale !== undefined && typeof draft.rationale !== "string")
      throw new ProposalHostError("INVALID_REQUEST", "rationale is text");
    const snap = this.session.ready();
    // Same revision ID is not the same model (two branches can both hold rev-1). A draft on
    // another revision is left to the engine, which answers STALE_REVISION; a draft on a
    // different model under the same revision ID would slip past that check, so it stops here.
    if (snap.model.project.modelRevision === draft.expectedRevision && snap.key !== draft.modelKey)
      throw new StaleDraftError(
        `the edits were staged on another model that is also called ${draft.expectedRevision}; the checkout now holds ${snap.key}. Restage them on the current model.`,
      );
    const operations = toOperations(snap.model, draft.edits);
    const rationale = draft.rationale?.trim();
    return {
      before: snap.model.project.modelRevision,
      root: snap.status.root,
      change: {
        changeId,
        projectId: snap.model.project.id,
        // Kept as staged: the engine reports STALE_REVISION if the model moved since.
        expectedRevision: draft.expectedRevision,
        ...(rationale ? { rationale } : {}),
        operations,
      },
    };
  }

  private dryRun(change: Record<string, unknown>): DraftPreview {
    const expected = change.expectedRevision as string;
    const r = previewProposal(this.session.path, { change });
    if (r.ok) return summarize(r.data, expected, r.context.modelRevision);
    // An operation that does not match its typed schema (an empty name, say) is the draft's
    // problem, not the request's: show it with the engine's other errors, field by field.
    if (r.error.code === "INVALID_REQUEST" && r.error.details?.length) {
      const ops = change.operations as { type: string }[];
      return {
        operations: ops.map((o, index) => ({ index, type: o.type, summary: "" })),
        expectedRevision: expected,
        currentRevision: r.context?.modelRevision ?? this.session.ready().model.project.modelRevision,
        validation: {
          appliesToCurrent: false,
          errors: r.error.details.map((d) => ({
            code: "SCHEMA",
            severity: "error",
            path: d.path.replace(/^change\./, ""),
            message: d.message,
            hint: "The edit does not match its typed operation; fix the value and stage it again.",
          })),
          warnings: [],
        },
        delta: null,
        impact: null,
        bindings: { total: 0, note: "" },
        assumptions: [],
      };
    }
    throw new ProposalHostError(r.error.code, r.error.message);
  }
}

function summarize(p: ProposalPreview, expectedRevision: string, currentRevision: string): DraftPreview {
  return {
    operations: p.proposal.operations,
    expectedRevision,
    currentRevision,
    validation: {
      appliesToCurrent: p.validation.appliesToCurrent,
      errors: p.validation.errors,
      warnings: p.validation.warnings,
    },
    delta: p.delta
      ? {
          against: p.delta.against,
          revision: p.delta.revision,
          changes: p.delta.changes,
          total: p.delta.total,
          truncated: p.delta.truncated,
        }
      : null,
    impact: p.impact
      ? {
          modules: p.impact.modules,
          crossModule: p.impact.crossModule,
          total: p.impact.total,
          note: p.impact.note,
        }
      : null,
    bindings: { total: p.bindings.total, note: p.bindings.note },
    assumptions: p.assumptions,
  };
}
