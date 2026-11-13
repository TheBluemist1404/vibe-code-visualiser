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
import type { Id } from "@vcv/ir";
import { canonicalJson, proposalDigest, proposedChangeSchema, sha256Hex, digestOf } from "@vcv/core";
import type { ChangeRecord, ImplementationRequest } from "@vcv/core";
import { verifyBinding } from "./bindings.ts";
import { formatLocator } from "./locator.ts";
import { approvalCheck } from "./integrity.ts";
import { TRUST_VERIFICATION, readAttestation } from "./approval.ts";
import { changedFilesSince } from "./git.ts";
import { VCV_DIR } from "./project.ts";
import { worktreeState } from "./worktree.ts";
import type { WorktreeState } from "./worktree.ts";
import { failFinal, finish, observed } from "./shared/observation.ts";
import type { Observation, ObserveHooks } from "./shared/observation.ts";
import type { RepoResult } from "./shared/result.ts";
import { readClaims } from "./shared/claims.ts";
import { describeOperation, diffModels, impactOf } from "./shared/model-diff.ts";
import type { ObjectChange } from "./shared/model-diff.ts";
import { redact } from "./shared/redact.ts";
import type { ModelImpact } from "./shared/model-diff.ts";
import { readRevision } from "./shared/observation.ts";

export const HANDOFF_LIMITS = {
  delta: 50,
  candidates: 30,
  bindings: 50,
  scopeFromBindings: 50,
  testsBound: 50,
  operations: 100,
  laterRevisions: 20,
  rationaleChars: 4000,
  summaryChars: 500,
  /** The whole handoff as printed (2-space JSON), digest included. */
  bytes: 128 * 1024,
} as const;

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
    /** Display text, cut to HANDOFF_LIMITS.rationaleChars; the proposal digest covers the full text. */
    rationale: string | null;
    rationaleTruncated: boolean;
    /** Display summaries (each cut to HANDOFF_LIMITS.summaryChars), at most HANDOFF_LIMITS.operations. */
    operations: { index: number; type: string; summary: string }[];
    operationsTotal: number;
    operationsTruncated: boolean;
  };
  /** The attestation, checked here without a trust list: provenance is decided by the host gate. */
  approval: {
    attestation: "valid-signature";
    keyFingerprint: string | null;
    trustVerification: typeof TRUST_VERIFICATION;
    note: string;
  };
  /** Where the model is now; later revisions are other changes this handoff does not cover. */
  modelNow: { revision: string; atApprovedRevision: boolean; laterRevisions: string[]; laterRevisionsTotal: number };
  delta: { changes: ObjectChange[]; total: number; truncated: boolean };
  impact: ModelImpact & { listsTruncated: boolean };
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
    boundTotal: number;
    boundTruncated: boolean;
  };
  bindings: { items: HandoffBinding[]; total: number; truncated: boolean };
  git: {
    baseCommit: string | null;
    branch: string | null;
    dirty: boolean | null;
    /** The bytes this handoff was derived from: bound source files and files changed since HEAD. */
    worktree: WorktreeState;
  };
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
export function buildHandoff(path: string, changeId: string, hooks: ObserveHooks = {}): RepoResult<Handoff> {
  return observed(path, hooks, (obs) => {
    const attestation = attestationKey(obs, changeId);
    const brief = approvedChange(obs, changeId);
    if ("error" in brief) return failFinal(brief.error, obs, hooks);
    const claims = readClaims(obs.status.root);
    // Snapshot the working tree before binding verification reads it, and recheck after.
    const tree = worktreeOf(obs, obs.commit, claims.entries);
    if (!tree)
      return failFinal(
        { code: "STORE_ERROR", message: "the working tree could not be compared with HEAD" },
        obs,
        hooks,
      );
    const handoff = assemble(obs, brief, claims.entries, tree.state);
    if ("error" in handoff) return failFinal(handoff.error, obs, hooks);
    return finish(obs, hooks, handoff, guardOf(obs, changeId, attestation, obs.commit, claims, tree));
  });
}

/**
 * The working-tree part of an observation: the files changed since `base` (none without Git or a
 * base) outside .vcv/implementations/, plus every file a binding claim points at, with their bytes.
 */
export function worktreeOf(
  obs: Observation,
  base: string | null,
  entries: ReturnType<typeof readClaims>["entries"],
): { changed: string[]; state: WorktreeState } | null {
  const root = obs.status.root;
  let changed: string[] = [];
  if (obs.status.git && base) {
    const c = changedFilesSince(root, base);
    if (!c) return null;
    changed = c.filter((f) => !f.startsWith(`${VCV_DIR}/implementations/`));
  }
  const bound = entries.map((e) => e.claim?.locator.path).filter((p): p is string => !!p);
  return { changed, state: worktreeState(root, [...changed, ...bound]) };
}

/**
 * What finish() rechecks besides the store, commit and change records: the claim files, the
 * attestation of the change, and the working tree (changed-file set and bytes), plus `more`
 * (e.g. the report file's bytes).
 */
export function guardOf(
  obs: Observation,
  changeId: string,
  attestation: string,
  base: string | null,
  claims: ReturnType<typeof readClaims>,
  tree: { changed: string[]; state: WorktreeState },
  more?: { key: string; again: () => string },
): { key: string; again: () => string } {
  const keyOf = (
    claimsKey: string,
    att: string,
    t: { changed: string[]; state: WorktreeState } | null,
    m: string | null,
  ) => canonicalJson([claimsKey, att, t ? [t.changed, t.state.digest] : "unreadable", m]);
  return {
    key: keyOf(claims.key, attestation, tree, more ? more.key : null),
    again: () => {
      const c = readClaims(obs.status.root);
      return keyOf(c.key, attestationKey(obs, changeId), worktreeOf(obs, base, c.entries), more ? more.again() : null);
    },
  };
}

/** The attestation file as read now; read it before approvedChange() so the guard covers that read. */
export function attestationKey(obs: Observation, changeId: string): string {
  try {
    return canonicalJson(readAttestation(obs.status.storeDir, changeId));
  } catch (e) {
    return `unreadable:${(e as Error).message}`;
  }
}

export type ApprovedChange = {
  record: ChangeRecord & { resultingRevision: string };
  request: ImplementationRequest | null;
  changes: ObjectChange[];
  impact: ModelImpact;
  keyFingerprint: string | null;
};

/** The approved change behind a handoff or a report, from one observation. */
export function approvedChange(
  obs: Observation,
  changeId: string,
):
  | ApprovedChange
  | {
      error: {
        code: "UNKNOWN_CHANGE" | "INVALID_RECORD" | "NOT_APPLIED" | "NOT_IN_HISTORY" | "NOT_ATTESTED";
        message: string;
      };
    } {
  const entry = obs.records.find((e) => e.changeId === changeId);
  if (!entry) return { error: { code: "UNKNOWN_CHANGE", message: `no change record "${changeId}" in this checkout` } };
  const parsed = entry.record ? proposedChangeSchema.safeParse(entry.record.change) : undefined;
  if (!entry.record || !parsed?.success)
    return {
      error: {
        code: "INVALID_RECORD",
        message: `change record "${changeId}" is unreadable: ${entry.problem ?? "its change does not match the typed change schema"}`,
      },
    };
  const r = entry.record;
  if (r.status !== "applied" || !r.resultingRevision)
    return {
      error: {
        code: "NOT_APPLIED",
        message: `change ${changeId} is ${r.status}: only an approved, applied change can be handed off for implementation`,
      },
    };
  if (!obs.history.includes(r.resultingRevision))
    return {
      error: {
        code: "NOT_IN_HISTORY",
        message: `${r.resultingRevision} (from ${changeId}) is not in this checkout's model history; check out the branch it was approved on`,
      },
    };
  const approval = approvalCheck(obs.status.storeDir, r, r.resultingRevision, null, false);
  // Without a trust list, a valid signature that matches the record reads "trust-unavailable".
  if (approval.state !== "trust-unavailable") {
    return {
      error: {
        code: "NOT_ATTESTED",
        message: `change ${changeId} has no valid approval attestation (${approval.state}: ${approval.detail}); approve it with vcv review approve, or finish a failed write with vcv review finalize`,
      },
    };
  }
  const before = readRevision(obs.reader, r.baseRevision);
  const after = readRevision(obs.reader, r.resultingRevision);
  if (!before || !after)
    return {
      error: { code: "NOT_IN_HISTORY", message: `the revisions of ${changeId} cannot be read in this checkout` },
    };
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
export function affectedBindings(
  obs: Observation,
  brief: ApprovedChange,
  entries: ReturnType<typeof readClaims>["entries"],
): HandoffBinding[] {
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

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function assemble(
  obs: Observation,
  brief: ApprovedChange,
  entries: ReturnType<typeof readClaims>["entries"],
  worktree: WorktreeState,
): Handoff | { error: { code: "HANDOFF_TOO_LARGE"; message: string } } {
  const r = brief.record;
  const change = r.change as { rationale?: string; operations: Parameters<typeof describeOperation>[0][] };
  const bindings = affectedBindings(obs, brief, entries);
  const at = obs.history.indexOf(r.resultingRevision);
  const later = obs.history.slice(at + 1);
  const scopeFiles = [...new Set(bindings.map((b) => b.locator.split("#")[0]!))].sort();
  const bound = bindings
    .filter((b) => b.relation === "tests")
    .map((b) => ({ bindingId: b.bindingId, modelObjectId: b.modelObjectId, locator: b.locator }));
  const rationale = change.rationale ?? null;
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
      rationale: rationale === null ? null : cut(rationale, HANDOFF_LIMITS.rationaleChars),
      rationaleTruncated: rationale !== null && rationale.length > HANDOFF_LIMITS.rationaleChars,
      operations: change.operations.slice(0, HANDOFF_LIMITS.operations).map((op, index) => ({
        index,
        type: op.type,
        summary: cut(describeOperation(op), HANDOFF_LIMITS.summaryChars),
      })),
      operationsTotal: change.operations.length,
      operationsTruncated: change.operations.length > HANDOFF_LIMITS.operations,
    },
    approval: {
      attestation: "valid-signature",
      keyFingerprint: brief.keyFingerprint,
      trustVerification: TRUST_VERIFICATION,
      note: "Signature checked against the record; key trust is decided by the host gate (docs/approvals.md).",
    },
    modelNow: {
      revision: obs.model.project.modelRevision,
      atApprovedRevision: obs.model.project.modelRevision === r.resultingRevision,
      laterRevisions: later.slice(0, HANDOFF_LIMITS.laterRevisions),
      laterRevisionsTotal: later.length,
    },
    delta: {
      changes: brief.changes.slice(0, HANDOFF_LIMITS.delta),
      total: brief.changes.length,
      truncated: brief.changes.length > HANDOFF_LIMITS.delta,
    },
    impact: { ...brief.impact, listsTruncated: false },
    request: brief.request,
    scope: {
      declared: brief.request?.scope ?? null,
      fromBindings: scopeFiles.slice(0, HANDOFF_LIMITS.scopeFromBindings),
      fromBindingsTruncated: scopeFiles.length > HANDOFF_LIMITS.scopeFromBindings,
    },
    tests: {
      requested: brief.request?.suggestedTests ?? [],
      bound: bound.slice(0, HANDOFF_LIMITS.testsBound),
      boundTotal: bound.length,
      boundTruncated: bound.length > HANDOFF_LIMITS.testsBound,
    },
    bindings: {
      items: bindings.slice(0, HANDOFF_LIMITS.bindings),
      total: bindings.length,
      truncated: bindings.length > HANDOFF_LIMITS.bindings,
    },
    git: {
      baseCommit: obs.commit,
      branch: obs.status.git?.branch ?? null,
      dirty: obs.status.git?.dirty ?? null,
      worktree,
    },
    steps: STEPS,
    caveats: [
      ...CAVEATS,
      ...(brief.request
        ? []
        : [
            "The proposal carried no implementation request: there are no approved acceptance criteria or scope; ask the reviewer before implementing.",
          ]),
      ...(obs.status.git?.dirty
        ? [
            "The working tree is dirty: the base commit does not describe all of the starting point (git.worktree names the bytes seen).",
          ]
        : []),
      ...(later.length
        ? [
            `The model has moved past the approved revision (${later.length} later revision${later.length === 1 ? "" : "s"}, see modelNow): those changes are not part of this handoff.`,
          ]
        : []),
      ...(rationale !== null && rationale.length > HANDOFF_LIMITS.rationaleChars
        ? ["The rationale is shortened for display; the proposal digest covers the full text in the change record."]
        : []),
    ],
  };
  return boundBytes(redact(body, obs.status.root));
}

/** The handoff as printed, digest included: what the byte limit applies to. */
export const handoffBytes = (h: Handoff) => Buffer.byteLength(JSON.stringify(h, null, 2));

const seal = (b: Omit<Handoff, "digest">): Handoff => ({ ...b, digest: digestOf(b) });

/**
 * Keep the printed handoff (digest included) within HANDOFF_LIMITS.bytes: halve the longest
 * derived lists, each marked truncated, until it fits; never the approved identity (change ID,
 * digests, revisions, request). If it still does not fit, fail with HANDOFF_TOO_LARGE rather than
 * returning more than the limit.
 */
function boundBytes(b: Omit<Handoff, "digest">): Handoff | { error: { code: "HANDOFF_TOO_LARGE"; message: string } } {
  const half = <T>(xs: T[]) => xs.slice(0, Math.floor(xs.length / 2));
  const cutters: [() => number, () => void][] = [
    [
      () => b.delta.changes.length,
      () => (b = { ...b, delta: { ...b.delta, changes: half(b.delta.changes), truncated: true } }),
    ],
    [
      () => b.impact.candidates.length,
      () =>
        (b = {
          ...b,
          impact: { ...b.impact, candidates: half(b.impact.candidates), truncated: true, listsTruncated: true },
        }),
    ],
    [
      () => b.bindings.items.length,
      () => (b = { ...b, bindings: { ...b.bindings, items: half(b.bindings.items), truncated: true } }),
    ],
    [
      () => b.tests.bound.length,
      () => (b = { ...b, tests: { ...b.tests, bound: half(b.tests.bound), boundTruncated: true } }),
    ],
    [
      () => b.scope.fromBindings.length,
      () =>
        (b = { ...b, scope: { ...b.scope, fromBindings: half(b.scope.fromBindings), fromBindingsTruncated: true } }),
    ],
    [
      () => b.impact.modules.length + b.impact.contracts.length,
      () =>
        (b = {
          ...b,
          impact: {
            ...b.impact,
            modules: half(b.impact.modules),
            contracts: half(b.impact.contracts),
            listsTruncated: true,
          },
        }),
    ],
    [
      () => b.change.operations.length,
      () => (b = { ...b, change: { ...b.change, operations: half(b.change.operations), operationsTruncated: true } }),
    ],
  ];
  let h = seal(b);
  while (handoffBytes(h) > HANDOFF_LIMITS.bytes) {
    const next = cutters
      .map(([n, c]) => [n(), c] as const)
      .filter(([n]) => n > 0)
      .sort((p, q) => q[0] - p[0])[0];
    if (!next) {
      return {
        error: {
          code: "HANDOFF_TOO_LARGE",
          message: `the handoff would be ${handoffBytes(h)} bytes, over its ${HANDOFF_LIMITS.bytes}-byte limit, even with every derived list cut; read the change with vcv proposal show and the delta with vcv proposal preview`,
        },
      };
    }
    next[1]();
    h = seal(b);
  }
  return h;
}
