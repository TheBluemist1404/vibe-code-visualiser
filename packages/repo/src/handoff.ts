// The bounded implementation handoff (Issue #17, M3.3).
//
// After a change is approved, the coding agent that will implement it needs one reviewable
// brief: what was approved (the operations, the delta, the implementation request the reviewer
// approved with them), what it touches structurally, which binding claims point at that code and
// how fresh they are, where the work starts (base commit, branch), the declared scope, and what
// to do afterwards. `buildHandoff` derives that brief, read-only and deterministically, from one
// observation of the checkout. It never triggers anything: the agent is invoked by the person,
// with its normal tools, and must inspect the code itself.
//
// Deterministic: no timestamps, stable ordering, bounded lists; the same checkout state gives the
// same bytes and the same `digest`. Redacted: only repository-relative paths; the checkout's
// absolute path and the home directory never appear (free text is scrubbed too).
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { Id } from "@vcv/ir";
import { canonicalJson, proposalDigest, proposedChangeSchema } from "@vcv/core";
import type { ChangeRecord, ImplementationRequest } from "@vcv/core";
import { verifyBinding } from "./bindings.ts";
import { formatLocator } from "./locator.ts";
import { approvalCheck } from "./integrity.ts";
import { TRUST_VERIFICATION } from "./approval.ts";
import { describeOperation, diffModels, failFinal, finish, impactOf, observed, readClaims, readRevision } from "./proposals.ts";
import type { ObjectChange, Observation, ProposalHooks, ProposalPreview, ProposalResult } from "./proposals.ts";

export const HANDOFF_LIMITS = { delta: 50, candidates: 30, bindings: 50, scopeFromBindings: 50, bytes: 128 * 1024 } as const;

export type HandoffBinding = {
  bindingId: string;
  modelObjectId: Id;
  relation: string;
  locator: string;
  why: "changed" | "removed" | "impacted";
  /** verifyBinding now, against the working tree. "resolved" is not "correct". */
  state: string;
  source: string | null;
  model: string | null;
  /** True for claims on changed or removed objects: re-inspect and reassert after implementing. */
  reassertAfterImplementing: boolean;
};

export type Handoff = {
  format: 1;
  kind: "vcv-implementation-handoff";
  project: { id: string; name: string };
  change: {
    changeId: string;
    proposalDigest: string;
    baseRevision: string;
    approvedRevision: string;
    proposerId: string;
    approverId: string | null;
    rationale: string | null;
    operations: { index: number; type: string; summary: string }[];
  };
  /** The attestation, checked here without a trust list: provenance is decided by the host gate. */
  approval: { attestation: "valid-signature"; keyFingerprint: string | null; trustVerification: typeof TRUST_VERIFICATION; note: string };
  /** Where the model is now; later revisions are other changes this handoff does not cover. */
  modelNow: { revision: string; atApprovedRevision: boolean; laterRevisions: string[] };
  delta: { changes: ObjectChange[]; total: number; truncated: boolean };
  impact: NonNullable<ProposalPreview["impact"]>;
  /** The implementation request approved with the change, or null when the proposal had none. */
  request: ImplementationRequest | null;
  scope: {
    /** Approved scope (request.scope). null: not declared, so every changed file is unscoped. */
    declared: string[] | null;
    /** Files binding claims point at for changed or impacted objects: code that probably moves too. */
    fromBindings: string[];
    fromBindingsTruncated: boolean;
  };
  tests: {
    requested: string[];
    /** Claims with relation "tests" on changed or impacted objects. */
    bound: { bindingId: string; modelObjectId: Id; locator: string }[];
  };
  bindings: { items: HandoffBinding[]; total: number; truncated: boolean };
  git: { baseCommit: string | null; branch: string | null; dirty: boolean | null };
  /** What the implementing agent does, in order. Fixed text. */
  steps: string[];
  caveats: string[];
  /** sha256 over the canonical JSON of everything above. */
  digest: string;
};

const STEPS = [
  "Work in this checkout, on the branch and from the base commit above. Inspect the code yourself: the delta, impact and binding claims are pointers, not proof of where or how the code must change.",
  "Implement the requested behavior and its tests within the declared scope. If the change needs code outside it, or a different model, stop: model intent changes only through a new proposal and a new review (vcv proposal submit).",
  "Never edit .vcv/HEAD, .vcv/revisions/, .vcv/changes/ or .vcv/approvals/ by hand.",
  "After implementing, re-inspect the code for every claim marked reassertAfterImplementing, and reassert it explicitly (vcv binding reassert … --expect <digest>, or vcv binding add for new code). Reassertion is your claim, not an approval.",
  "Run the tests and record what really happened, then record the implementation report: vcv implementation record <path> <changeId> --report <file> (see docs/implementation.md).",
];

const CAVEATS = [
  "Approved model intent is not implemented source: this handoff says what was approved, not what the code does.",
  "Binding states are VCV-verified locator facts about the working tree now (does the pointer resolve, did the code or model change since the claim); their meaning is the claimant's and unverified.",
  "Impact is structural (declared model references), not a code, test or runtime analysis.",
  "The attestation's signature was checked against the change record; whether its key is trusted is decided by the host gate (vcv integrity against the protected base), not here.",
  "Nothing in this handoff is reconciled against the code; that is M4.",
];

/**
 * Build the handoff for an applied, attested change. Read-only; one observation (STATE_CHANGED
 * if the checkout moved while reading). Errors: UNKNOWN_CHANGE, INVALID_RECORD, NOT_APPLIED,
 * NOT_IN_HISTORY, NOT_ATTESTED, PROJECT_NOT_READY, STORE_ERROR, STATE_CHANGED.
 */
export function buildHandoff(path: string, changeId: string, hooks: ProposalHooks = {}): ProposalResult<Handoff> {
  return observed(path, hooks, (obs) => {
    const brief = approvedChange(obs, changeId);
    if ("error" in brief) return failFinal(brief.error, obs, hooks);
    const claims = readClaims(obs.status.root);
    const handoff = assemble(obs, brief, claims.entries);
    return finish(obs, hooks, handoff, { key: claims.key, again: () => readClaims(obs.status.root).key });
  });
}

export type ApprovedChange = {
  record: ChangeRecord & { resultingRevision: string };
  request: ImplementationRequest | null;
  changes: ObjectChange[];
  impact: NonNullable<ProposalPreview["impact"]>;
  keyFingerprint: string | null;
};

/** The approved change behind a handoff or a report, from one observation. */
export function approvedChange(obs: Observation, changeId: string): ApprovedChange | { error: { code: "UNKNOWN_CHANGE" | "INVALID_RECORD" | "NOT_APPLIED" | "NOT_IN_HISTORY" | "NOT_ATTESTED"; message: string } } {
  const entry = obs.records.find((e) => e.changeId === changeId);
  if (!entry) return { error: { code: "UNKNOWN_CHANGE", message: `no change record "${changeId}" in this checkout` } };
  const parsed = entry.record ? proposedChangeSchema.safeParse(entry.record.change) : undefined;
  if (!entry.record || !parsed?.success) return { error: { code: "INVALID_RECORD", message: `change record "${changeId}" is unreadable: ${entry.problem ?? "its change does not match the typed change schema"}` } };
  const r = entry.record;
  if (r.status !== "applied" || !r.resultingRevision) return { error: { code: "NOT_APPLIED", message: `change ${changeId} is ${r.status}: only an approved, applied change can be handed off for implementation` } };
  if (!obs.history.includes(r.resultingRevision)) return { error: { code: "NOT_IN_HISTORY", message: `${r.resultingRevision} (from ${changeId}) is not in this checkout's model history; check out the branch it was approved on` } };
  const approval = approvalCheck(obs.status.storeDir, r, r.resultingRevision, null, false);
  // Without a trust list, a valid signature that matches the record reads "trust-unavailable".
  if (approval.state !== "trust-unavailable") {
    return { error: { code: "NOT_ATTESTED", message: `change ${changeId} has no valid approval attestation (${approval.state}: ${approval.detail}); approve it with vcv review approve, or finish a failed write with vcv review finalize` } };
  }
  const before = readRevision(obs.reader, r.baseRevision);
  const after = readRevision(obs.reader, r.resultingRevision);
  if (!before || !after) return { error: { code: "NOT_IN_HISTORY", message: `the revisions of ${changeId} cannot be read in this checkout` } };
  const changes = diffModels(before, after);
  return {
    record: r as ApprovedChange["record"],
    request: parsed.data.implementation ?? null,
    changes,
    impact: impactOf(before, after, changes, HANDOFF_LIMITS.candidates),
    keyFingerprint: approval.keyFingerprint ?? null,
  };
}

/** Binding claims on the changed or impacted objects of an approved change, verified now. */
export function affectedBindings(obs: Observation, brief: ApprovedChange, entries: ReturnType<typeof readClaims>["entries"]): HandoffBinding[] {
  const why = new Map<Id, HandoffBinding["why"]>();
  for (const c of brief.changes) why.set(c.id, c.change === "removed" ? "removed" : "changed");
  for (const c of brief.impact.candidates) if (!why.has(c.id)) why.set(c.id, "impacted");
  const out: HandoffBinding[] = [];
  for (const e of entries) {
    const c = e.claim;
    const w = c && why.get(c.modelObjectId);
    if (!c || !w) continue;
    const v = verifyBinding(obs.status.root, e, obs.status);
    out.push({
      bindingId: e.bindingId,
      modelObjectId: c.modelObjectId,
      relation: c.relation,
      locator: formatLocator(c.locator),
      why: w,
      state: v.state,
      source: v.source?.state ?? null,
      model: v.model?.state ?? null,
      reassertAfterImplementing: w !== "impacted",
    });
  }
  return out.sort((p, q) => (p.bindingId < q.bindingId ? -1 : p.bindingId > q.bindingId ? 1 : 0));
}

function assemble(obs: Observation, brief: ApprovedChange, entries: ReturnType<typeof readClaims>["entries"]): Handoff {
  const r = brief.record;
  const change = r.change as { rationale?: string; operations: Parameters<typeof describeOperation>[0][] };
  const bindings = affectedBindings(obs, brief, entries);
  const at = obs.history.indexOf(r.resultingRevision);
  const scopeFiles = [...new Set(bindings.map((b) => b.locator.split("#")[0]!))].sort();
  const body: Omit<Handoff, "digest"> = {
    format: 1,
    kind: "vcv-implementation-handoff",
    project: { id: obs.model.project.id, name: obs.model.project.name },
    change: {
      changeId: r.changeId,
      proposalDigest: proposalDigest(r.change),
      baseRevision: r.baseRevision,
      approvedRevision: r.resultingRevision,
      proposerId: r.proposerId,
      approverId: r.approverId ?? null,
      rationale: change.rationale ?? null,
      operations: change.operations.map((op, index) => ({ index, type: op.type, summary: describeOperation(op) })),
    },
    approval: {
      attestation: "valid-signature",
      keyFingerprint: brief.keyFingerprint,
      trustVerification: TRUST_VERIFICATION,
      note: "Signature checked against the record; key trust is decided by the host gate (docs/approvals.md).",
    },
    modelNow: { revision: obs.model.project.modelRevision, atApprovedRevision: obs.model.project.modelRevision === r.resultingRevision, laterRevisions: obs.history.slice(at + 1) },
    delta: { changes: brief.changes.slice(0, HANDOFF_LIMITS.delta), total: brief.changes.length, truncated: brief.changes.length > HANDOFF_LIMITS.delta },
    impact: brief.impact,
    request: brief.request,
    scope: { declared: brief.request?.scope ?? null, fromBindings: scopeFiles.slice(0, HANDOFF_LIMITS.scopeFromBindings), fromBindingsTruncated: scopeFiles.length > HANDOFF_LIMITS.scopeFromBindings },
    tests: {
      requested: brief.request?.suggestedTests ?? [],
      bound: bindings.filter((b) => b.relation === "tests").map((b) => ({ bindingId: b.bindingId, modelObjectId: b.modelObjectId, locator: b.locator })),
    },
    bindings: { items: bindings.slice(0, HANDOFF_LIMITS.bindings), total: bindings.length, truncated: bindings.length > HANDOFF_LIMITS.bindings },
    git: { baseCommit: obs.commit, branch: obs.status.git?.branch ?? null, dirty: obs.status.git?.dirty ?? null },
    steps: STEPS,
    caveats: [
      ...CAVEATS,
      ...(brief.request ? [] : ["The proposal carried no implementation request: there are no approved acceptance criteria or scope; ask the reviewer before implementing."]),
      ...(obs.status.git?.dirty ? ["The working tree is dirty: the base commit does not describe all of the starting point."] : []),
      ...(obs.history.length > at + 1 ? [`The model has moved past the approved revision (${obs.history.slice(at + 1).join(", ")}): those changes are not part of this handoff.`] : []),
    ],
  };
  const redacted = boundBytes(redact(body, obs.status.root));
  return { ...redacted, digest: digestOf(redacted) };
}

export const digestOf = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");

/** Replace the checkout's absolute path and the home directory in every string. */
export function redact<T>(v: T, root: string): T {
  const home = homedir();
  const scrub = (s: string) => {
    let out = s.split(root).join("<checkout>");
    if (home && home.length > 1) out = out.split(home).join("~");
    return out;
  };
  const walk = (x: unknown): unknown =>
    typeof x === "string" ? scrub(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
  return walk(v) as T;
}

/** Keep the handoff under its byte budget by cutting the longest lists first. */
function boundBytes(h: Omit<Handoff, "digest">): Omit<Handoff, "digest"> {
  const size = () => Buffer.byteLength(JSON.stringify(h));
  while (size() > HANDOFF_LIMITS.bytes) {
    if (h.delta.changes.length > 5) h = { ...h, delta: { ...h.delta, changes: h.delta.changes.slice(0, Math.floor(h.delta.changes.length / 2)), truncated: true } };
    else if (h.impact.candidates.length > 5) h = { ...h, impact: { ...h.impact, candidates: h.impact.candidates.slice(0, Math.floor(h.impact.candidates.length / 2)), truncated: true } };
    else if (h.bindings.items.length > 5) h = { ...h, bindings: { ...h.bindings, items: h.bindings.items.slice(0, Math.floor(h.bindings.items.length / 2)), truncated: true } };
    else break;
  }
  return h;
}
