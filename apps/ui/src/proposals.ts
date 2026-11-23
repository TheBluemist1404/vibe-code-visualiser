// The proposal inbox (M5.4, Issue #44): a read-only presenter over @vcv/repo's listProposals,
// previewProposal and checkIntegrity. Nothing here records, approves, signs or validates on its
// own; every state shown is one of those functions' answers, labelled with what it does not prove.
//
// The reviewer step stays outside this host: approval needs the reviewer's private key, which
// never enters this process or the browser, so a pending proposal gets the exact CLI command for
// its digest instead of a button.
import { checkIntegrity, listProposals, previewProposal } from "@vcv/repo";
import type { IntegrityReport, ProposalPreview, ProposalSummary, RevisionCheck } from "@vcv/repo";
import { consistentRead } from "./observe.ts";
import type { ProjectSession } from "./session.ts";
import type { Inbox, InboxItem, ProposalReview, ReviewStep } from "./types.ts";

export class InboxUnavailable extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Where integrity is checked from, if the person who started the host named a protected base. */
export type InboxOptions = {
  protectedBase?: string;
  /** Test hook: called between the reads that make up one answer. */
  betweenReads?: (step: "after-preview" | "after-list" | "after-integrity") => void;
};

const LIST_LIMIT = 200;

export class ProposalInbox {
  private readonly session: ProjectSession;
  private readonly opts: InboxOptions;

  constructor(session: ProjectSession, opts: InboxOptions = {}) {
    this.session = session;
    this.opts = opts;
  }

  /**
   * Every answer is composed from one observed state: the reads run between two identity checks
   * (model, Git, every .vcv/ record and attestation, the protected base's commit) and are retried
   * if anything moved, then refused with STATE_CHANGED (src/observe.ts).
   */
  list(): Inbox {
    return consistentRead(this.session.path, () => this.listOnce(), this.observe());
  }

  review(changeId: string): ProposalReview {
    return consistentRead(this.session.path, () => this.reviewOnce(changeId), this.observe());
  }

  private observe() {
    return this.opts.protectedBase ? { ref: this.opts.protectedBase } : {};
  }

  private listOnce(): Inbox {
    const s = this.session.ready();
    const r = listProposals(this.session.path, { limit: LIST_LIMIT });
    if (!r.ok) throw new InboxUnavailable(r.error.code, r.error.message);
    return {
      modelKey: s.key,
      revision: r.context.modelRevision,
      items: r.data.proposals.map(item),
      counts: r.data.counts,
      total: r.data.total,
      truncated: r.data.truncated,
      protectedBase: this.opts.protectedBase ?? null,
    };
  }

  private reviewOnce(changeId: string): ProposalReview {
    const s = this.session.ready();
    const path = this.session.path;
    const r = previewProposal(path, { changeId, limit: 50 });
    if (!r.ok) throw new InboxUnavailable(r.error.code, r.error.message);
    this.opts.betweenReads?.("after-preview");
    const listed = listProposals(path, { limit: LIST_LIMIT });
    this.opts.betweenReads?.("after-list");
    const summary = listed.ok ? listed.data.proposals.find((p) => p.changeId === changeId) : undefined;
    const p = r.data;
    const current = r.context.modelRevision;
    const root = s.status.root;
    // Signature: checked without any trust source, so "valid" means only that the file verifies
    // and matches the record, never that the key belongs to a trusted reviewer.
    const local = summary?.resultingRevision ? checkIntegrity(path, {}) : null;
    const base = summary?.resultingRevision && this.opts.protectedBase ? this.protectedCheck() : null;
    this.opts.betweenReads?.("after-integrity");
    // The parts must describe one change in one state; the identity check around this read
    // covers the checkout, this covers the answers themselves.
    if (
      r.context.modelRevision !== s.model.project.modelRevision ||
      (summary?.proposalDigest && summary.proposalDigest !== r.data.proposal.proposalDigest)
    )
      throw new InboxUnavailable("STATE_CHANGED", "the proposal changed between reads; try again");
    return {
      changeId: p.proposal.changeId,
      lifecycle: p.proposal.lifecycle === "unsubmitted" ? "invalid" : p.proposal.lifecycle,
      proposalDigest: p.proposal.proposalDigest,
      proposerId: p.proposal.proposerId,
      projectId: p.proposal.projectId,
      baseRevision: p.proposal.baseRevision,
      currentRevision: current,
      modelKey: s.key,
      ...(p.proposal.rationale ? { rationale: p.proposal.rationale } : {}),
      ...(summary?.stale ? { stale: summary.stale } : {}),
      ...(summary?.resultingRevision ? { resultingRevision: summary.resultingRevision } : {}),
      ...(summary?.recordedApproverId ? { recordedApproverId: summary.recordedApproverId } : {}),
      check: checkOf(p, current, p.proposal.lifecycle === "applied"),
      atSubmission: p.validation.atSubmission ?? [],
      bindings: p.bindings,
      steps: steps(p, summary, local, base, this.opts.protectedBase),
      reviewer: p.proposal.lifecycle === "pending" ? reviewerHandoff(root, p) : null,
      agent: ["stale", "rejected", "invalid"].includes(p.proposal.lifecycle) ? agentHandoff(root, p, current) : null,
      integrityLimits: (base?.report ?? local)?.limits ?? [],
    };
  }

  private protectedCheck(): { report: IntegrityReport } | null {
    const ref = this.opts.protectedBase;
    if (!ref) return null;
    return { report: checkIntegrity(this.session.path, { base: ref, trust: { kind: "git-ref", ref } }) };
  }
}

function item(p: ProposalSummary): InboxItem {
  return {
    changeId: p.changeId,
    lifecycle: p.lifecycle,
    proposerId: p.proposerId,
    baseRevision: p.baseRevision,
    proposalDigest: p.proposalDigest,
    operations: p.operations,
    approval: p.approval,
    ...(p.rationale ? { rationale: p.rationale } : {}),
    ...(p.stale ? { stale: p.stale } : {}),
    ...(p.resultingRevision ? { resultingRevision: p.resultingRevision } : {}),
    ...(p.resultInThisCheckout !== undefined ? { resultInThisCheckout: p.resultInThisCheckout } : {}),
    ...(p.recordedApproverId ? { recordedApproverId: p.recordedApproverId } : {}),
    ...(p.problem ? { problem: p.problem } : {}),
  };
}

function checkOf(p: ProposalPreview, current: string, applied: boolean): ProposalReview["check"] {
  return {
    operations: p.proposal.operations,
    expectedRevision: p.proposal.baseRevision,
    currentRevision: current,
    // An applied change is history: rechecking it against the model it produced always reports
    // STALE_REVISION, which says nothing about the change. Its delta is shown against its base.
    validation: applied
      ? { appliesToCurrent: false, errors: [], warnings: [] }
      : {
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

/**
 * The lifecycle as separate facts, each from its own source. None implies another: a recorded
 * approver is not a signature, a valid signature is not trust, a local integrity check is not the
 * CI gate, and an applied model is not implemented code.
 */
function steps(
  p: ProposalPreview,
  s: ProposalSummary | undefined,
  local: IntegrityReport | null,
  base: { report: IntegrityReport } | null,
  protectedBase: string | undefined,
): ReviewStep[] {
  const lc = p.proposal.lifecycle;
  const out: ReviewStep[] = [];
  out.push({
    id: "recorded",
    label: "Submitted",
    state: lc === "invalid" ? "failed" : "done",
    detail:
      lc === "invalid"
        ? "The record file is unreadable; nothing about it can be shown."
        : lc === "rejected"
          ? "Recorded as rejected when it was submitted or rechecked; it can never be approved."
          : `Recorded in .vcv/changes/ by ${p.proposal.proposerId ?? "an unknown proposer"} (as written in the record).`,
  });
  const applied = lc === "applied";
  const revCheck = (r: IntegrityReport | null): RevisionCheck | undefined =>
    r?.revisions.find((c) => c.changeId === p.proposal.changeId);
  // Signature (no trust source): does an attestation exist, verify and match the record?
  const sig = revCheck(local);
  out.push(
    !applied
      ? {
          id: "signed",
          label: "Reviewer signature",
          state: "not-yet",
          detail:
            lc === "pending"
              ? "Not signed. Only a reviewer with a trusted key can sign, with the CLI below."
              : "Not applicable.",
        }
      : sig?.approval.state === "trust-unavailable"
        ? {
            id: "signed",
            label: "Reviewer signature",
            state: "done",
            detail: `An attestation for this digest verifies, signed by key ${sig.approval.keyFingerprint ?? "?"} for ${sig.approval.approverId ?? "?"}. Whether that key is trusted is not checked here.`,
          }
        : sig?.approval.state === "missing"
          ? {
              id: "signed",
              label: "Reviewer signature",
              state: "failed",
              detail: `No attestation file: who applied it is unknown (${sig.approval.detail}). A recorded approver ID is not a signature.`,
            }
          : {
              id: "signed",
              label: "Reviewer signature",
              state: sig ? "failed" : "unknown",
              detail: sig
                ? `The attestation does not verify: ${sig.approval.detail}.`
                : "This checkout's history does not contain the revision, so its attestation was not checked.",
            },
  );
  // Integrity under a protected base, only when the host was told which one.
  if (!applied) {
    out.push({ id: "integrity", label: "Integrity under protected base", state: "not-yet", detail: "Not applied." });
  } else if (!protectedBase || !base) {
    out.push({
      id: "integrity",
      label: "Integrity under protected base",
      state: "unknown",
      detail:
        "Unknown here: this UI was not given a protected base (start it with --protected-base <ref>). The authority is `vcv integrity` in CI against the protected branch.",
    });
  } else {
    const c = revCheck(base.report);
    const anchor = base.report.trust?.anchor ?? protectedBase;
    const errors = base.report.problems.filter((x) => x.severity === "error");
    out.push(
      c?.approval.state === "attested" && errors.length === 0
        ? {
            id: "integrity",
            label: "Integrity, checked locally (caller-asserted base)",
            state: "done",
            detail: `Checked on this computer against ${anchor}, a ref named when the explorer was started: ${c.approval.detail}. That ref is caller-asserted and can be moved by anyone with a shell here, so this is not the hosting service's verdict; CI's check against the protected branch is the authority.`,
          }
        : {
            id: "integrity",
            label: "Integrity under protected base",
            state: c ? "failed" : "unknown",
            detail: c
              ? `Not attested under ${anchor}: ${c.approval.detail}${errors.length ? `; ${errors.map((e) => e.code).join(", ")}` : ""}.`
              : `${anchor}: ${errors.map((e) => `${e.code}: ${e.message}`).join("; ") || "this revision is not in the checked history"}.`,
          },
    );
  }
  out.push({
    id: "model",
    label: "Model applied",
    state: applied ? (s?.resultInThisCheckout === false ? "unknown" : "done") : "not-yet",
    detail: applied
      ? s?.resultInThisCheckout === false
        ? `Applied as ${s.resultingRevision} on another line; this checkout's history does not contain it.`
        : `Committed as ${s?.resultingRevision ?? "a revision"} in .vcv/HEAD's history.`
      : lc === "pending"
        ? ".vcv/HEAD is unchanged until a reviewer approves."
        : "Not applied.",
  });
  out.push({
    id: "implementation",
    label: "Implementation",
    state: "unknown",
    detail: "Not verified. Approving intent says nothing about code; see vcv reconcile and the pre-merge gate.",
  });
  return out;
}

const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function reviewerHandoff(root: string, p: ProposalPreview): NonNullable<ProposalReview["reviewer"]> {
  const id = p.proposal.changeId;
  return {
    digest: p.proposal.proposalDigest,
    commands: [
      { label: "1. Preview it yourself (same digest, same checks)", text: `vcv proposal preview ${q(root)} ${id}` },
      {
        label: "2. Approve as the reviewer, in your own terminal",
        text: `vcv review approve ${q(root)} ${id} --digest ${p.proposal.proposalDigest} --key <your reviewer key file> --trust-commit <full commit ID of the protected base, from the hosting service>`,
      },
    ],
    notes: [
      "This window cannot approve. Approval needs your private reviewer key, which never enters this host, the browser or an agent's shell.",
      "The digest pins exactly the content above. If the proposal or the model changes before you sign, `vcv review approve` refuses (DIGEST_MISMATCH or STALE_REVISION) and nothing is applied.",
      "Copy the protected base's commit ID from the hosting service, not from this checkout: a local ref can be moved by anyone with a shell here.",
      "After you approve, this page refreshes on its own and shows the signed result; CI then checks it with `vcv integrity` against the protected branch.",
    ],
  };
}

function agentHandoff(root: string, p: ProposalPreview, current: string): NonNullable<ProposalReview["agent"]> {
  const id = p.proposal.changeId;
  const lc = p.proposal.lifecycle;
  return {
    note:
      lc === "stale"
        ? `Based on ${p.proposal.baseRevision}, but the model is now ${current}. Nothing here rebases it: an agent re-reads the current model and submits a new proposal under a new change ID.`
        : lc === "rejected"
          ? "Rejected proposals are final. An agent fixes the errors shown under What it changes and submits a new proposal under a new change ID."
          : "The record is unreadable. An agent or a person inspects the file; nothing here repairs it.",
    commands: [
      { label: "What the agent reads", text: `vcv proposal preview ${q(root)} ${id} --json` },
      { label: "Current model revision", text: current },
    ],
  };
}
