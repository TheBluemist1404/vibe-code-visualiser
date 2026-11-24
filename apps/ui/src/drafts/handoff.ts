// The handoff to an external coding agent: the draft as a strict proposed change, exactly the
// shape `vcv proposal preview --file` and `vcv proposal submit` read, on the draft's original
// base revision. Context that the change schema does not allow (draft ID, branch, model
// identity) travels as separate metadata. Nothing here claims a proposer, an approver or a status.
import type { DraftExport, DraftPreview, ModelIdentity } from "../types.ts";
import type { DraftFile } from "./format.ts";

export type HandoffChange = DraftExport["change"];

/** One change ID per draft version, so a re-export after more edits is a new change. */
export const changeIdFor = (draft: DraftFile) => `ui-${draft.draftId.slice(2)}-v${draft.version}`;

export function handoffChange(draft: DraftFile): HandoffChange {
  const rationale = draft.rationale.trim();
  return {
    changeId: changeIdFor(draft),
    projectId: draft.projectId,
    // The base the edits were staged on, never the current model: integrating onto a newer
    // model is the agent's engineering work, not something the browser does.
    expectedRevision: draft.base.revision,
    ...(rationale ? { rationale } : {}),
    operations: draft.steps.map((s) => s.operation),
  };
}

export function handoff(draft: DraftFile, current: ModelIdentity, preview: DraftPreview): DraftExport {
  const change = handoffChange(draft);
  const stale = draft.base.modelKey !== current.modelKey;
  const v = preview.validation;
  const check: DraftExport["metadata"]["check"] = stale
    ? "stale"
    : v.errors.length || !v.appliesToCurrent
      ? "invalid"
      : v.warnings.length
        ? "warnings"
        : "valid";
  const note = {
    valid:
      "The engine's dry run accepted this change on its base revision. It is not submitted, approved or implemented.",
    warnings: "The engine's dry run accepted this change with warnings. It is not submitted, approved or implemented.",
    invalid:
      "The engine's dry run refused this change (see the errors). It needs repair by an agent or a person before it can be submitted.",
    stale: `The checkout no longer holds the model this draft was staged on (${draft.base.revision}, now ${current.revision}). An agent has to integrate it; VCV did not retarget it.`,
  }[check];
  return {
    change,
    metadata: {
      format: "vcv-ui-draft-handoff-1",
      draftId: draft.draftId,
      draftVersion: draft.version,
      checkoutRoot: draft.checkoutRoot,
      base: draft.base,
      current,
      check,
      needsAgent: check === "stale" || check === "invalid",
      note,
    },
    fileName: `${change.changeId}.json`,
    commands: { preview: `vcv proposal preview ${draft.checkoutRoot} --file ${change.changeId}.json` },
  };
}
