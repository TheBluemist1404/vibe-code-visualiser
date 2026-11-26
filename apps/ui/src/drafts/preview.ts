// The dry run of a draft: the engine's own preview of an unsubmitted change (`previewProposal`,
// which runs `checkChange`). Read-only: nothing is recorded and nothing is authorized.
import { previewProposal } from "@vcv/repo";
import type { ProposalPreview } from "@vcv/repo";
import type { DraftPreview } from "../types.ts";
import type { HandoffChange } from "./handoff.ts";

export class PreviewFailed extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function dryRun(checkout: string, change: HandoffChange, currentRevision: string): DraftPreview {
  const r = previewProposal(checkout, { change });
  if (r.ok) return summarize(r.data, change.expectedRevision, r.context.modelRevision);
  // An operation that does not match its typed schema (an empty name, say) is the draft's
  // problem, not the request's: report it with the engine's other errors, operation by operation.
  if (r.error.code === "INVALID_REQUEST" && r.error.details?.length) {
    return {
      origin: "unsubmitted",
      operations: change.operations.map((o, index) => ({ index, type: String(o.type), summary: "" })),
      expectedRevision: change.expectedRevision,
      currentRevision: r.context?.modelRevision ?? currentRevision,
      validation: {
        appliesToCurrent: false,
        errors: r.error.details.map((d) => {
          const path = d.path.replace(/^change\./, "");
          return {
            code: "SCHEMA",
            severity: "error",
            path,
            message: d.message,
            hint: path.startsWith("implementation")
              ? "The implementation request is incomplete: it needs a behavior and at least one acceptance criterion, and scope lines must be repository-relative paths or globs. Complete it, or clear every field to send none."
              : "The operation does not match its typed schema. Remove the step and stage a corrected value, or hand the draft to an agent to repair.",
          };
        }),
        warnings: [],
      },
      delta: null,
      impact: null,
      bindings: { total: 0, note: "" },
      assumptions: [],
    };
  }
  throw new PreviewFailed(r.error.code, r.error.message);
}

function summarize(p: ProposalPreview, expectedRevision: string, currentRevision: string): DraftPreview {
  return {
    origin: "unsubmitted",
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
      ? { modules: p.impact.modules, crossModule: p.impact.crossModule, total: p.impact.total, note: p.impact.note }
      : null,
    bindings: { total: p.bindings.total, note: p.bindings.note },
    assumptions: p.assumptions,
  };
}
