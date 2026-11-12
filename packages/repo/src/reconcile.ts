// Pre-merge candidate/base reconciliation baseline (Issue #22, M4.1).
//
// Compares a candidate checkout (a PR branch, committed and dirty) with the protected base it
// targets, read-only, from one observation. It reports what VCV can establish and keeps apart
// what it cannot:
//
//   model      the approved model line: base revision, candidate revision, the revisions the
//              candidate introduces and how each was derived and approved (checkIntegrity), the
//              object-level delta and its structural impact candidates;
//   source     the files the candidate changes since the merge base (committed and uncommitted),
//              which binding claims point into each, and which are not mapped at all;
//   bindings   every claim relevant to the change, verified now (verifyBinding), and compared
//              with the claim file at the merge base (added, reasserted, removed);
//   findings   one list, each item labelled with its category and its basis: `checked` (VCV
//              compared something deterministically), `observed` (a fact about files and commits,
//              never a judgement about behaviour) or `not-checked` (VCV could not check it).
//
// Five things are never conflated: a changed file or commit (observed, not drift), a stale claim
// (the bound code or object changed since the claim), a missing binding (nothing locates the
// code of a changed object), a checked structural contradiction (integrity errors, claims on
// objects the approved model does not have), and a semantic concern (an agent's interpretation;
// VCV authors none, and M4.4 adds agent-authored observations as labelled claims).
//
// Coherent and bounded like every read surface since M2.4: the store, Git HEAD, the base ref, the
// claim files and the bytes of every changed or bound file are read again before answering; any
// movement (a branch flip, a same-path dirty edit) gives STATE_CHANGED instead of a mixed report.
// Lists are cut at fixed limits and say so. Paths are repository-relative; the checkout's absolute
// path never appears. Nothing is written, fetched, executed or inferred.
import { createHash } from "node:crypto";
import { z } from "zod";
import { buildIndex, loadModel, persistedIdProblem } from "@vcv/ir";
import type { Id, Model } from "@vcv/ir";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, readStoreFile, STORE_FILE_LIMITS } from "@vcv/core";
import { LIMITS as QUERY_LIMITS, createQueryApi } from "@vcv/query";
import type { ImpactCandidate } from "@vcv/query";
import { MAX_CLAIM_BYTES, verifyBinding } from "./bindings.ts";
import type { ClaimEntry, Verification } from "./bindings.ts";
import { changedFilesBetween, changedFilesSince, fileAtCommit, filesAtCommit, headCommit, isAncestor, mergeBase, resolveCommit } from "./git.ts";
import { checkIntegrity } from "./integrity.ts";
import type { IntegrityReport } from "./integrity.ts";
import { APPROVALS_DIR, REVIEWERS_FILE, readPlainFile } from "./approval.ts";
import type { TrustSource } from "./approval.ts";
import { formatLocator } from "./locator.ts";
import { VCV_DIR } from "./project.ts";
import { redact } from "./handoff.ts";
import { diffModels, failFinal, finish, impactOf, moduleOf, observed, readClaims } from "./proposals.ts";
import type { ObjectChange, Observation, ProposalHooks, ProposalPreview, ProposalResult } from "./proposals.ts";
import { worktreeState } from "./worktree.ts";
import type { WorktreeState } from "./worktree.ts";

export const RECONCILE_LIMITS = {
  files: 500,
  bindings: 500,
  findings: 500,
  changes: 200,
  candidates: 50,
  paths: 20,
  integrityItems: 100,
  revisions: 200,
  seeds: 100,
  /** Display strings (locators, causes, messages) are cut at these lengths; a cut locator carries the digest of the full text. */
  locatorChars: 300,
  textChars: 1000,
  /** The whole serialized report. Lists are cut further (and flagged) to fit; past that, REPORT_TOO_LARGE. */
  bytes: 512 * 1024,
} as const;

export const reconcileRequest = z
  .object({
    /** The protected base: a full commit ID from the hosting service (preferred), or a ref name. */
    base: z.string().min(1).max(256),
    /** Passed to the integrity check, as for `vcv integrity`. */
    trust: z
      .union([
        z.object({ kind: z.literal("file"), path: z.string().min(1) }).strict(),
        z.object({ kind: z.literal("git-ref"), ref: z.string().min(1), pinnedCommit: z.string().optional() }).strict(),
        z.object({ kind: z.literal("working-tree") }).strict(),
      ])
      .optional(),
    requireAttestation: z.boolean().optional(),
  })
  .strict();
export type ReconcileRequest = { base: string; trust?: TrustSource; requireAttestation?: boolean };

export type FindingCategory =
  /** The model history: derivation, approval attestations, base prefix (checkIntegrity). */
  | "integrity"
  /** A deterministic contradiction between claims and the approved model. */
  | "structural"
  /** The state of a binding claim: invalid, stale, missing or ambiguous locator, removed. */
  | "binding"
  /** Changed model objects whose code no claim locates. */
  | "coverage"
  /** Changed files and commits: facts, never drift by themselves. */
  | "source"
  /** What VCV could not check: unmapped files, unchecked selectors, cut lists. */
  | "unsupported";

export type FindingBasis = "checked" | "observed" | "not-checked";

export type ReconcileFinding = {
  code: string;
  category: FindingCategory;
  basis: FindingBasis;
  /** True when the finding is about something this candidate changed (a file, a claim, a model object or its impact). */
  related: boolean;
  message: string;
  /** What VCV actually compared to say this. */
  checked: string;
  objectIds?: Id[];
  bindingId?: string;
  path?: string;
  revision?: string;
  changeId?: string;
};

export type FileArea = "source" | "test" | "vcv-model" | "vcv-bindings" | "vcv-other";

export type ChangedFile = {
  path: string;
  area: FileArea;
  /** Changed by a commit between the merge base and HEAD. */
  committed: boolean;
  /** Differs between HEAD and the working tree (staged, unstaged, untracked or deleted). */
  uncommitted: boolean;
  /** Claims whose locator points into this file, and the objects they are about. */
  bindings: string[];
  objectIds: Id[];
};

export type ClaimAtBase = "unchanged" | "reasserted" | "added" | "removed";
export type ObjectInChange = "added" | "modified" | "removed" | "impacted" | "unchanged" | "not-in-model";

export type ReconciledBinding = {
  bindingId: string;
  modelObjectId: Id | null;
  relation: string | null;
  /** The locator as text, cut at RECONCILE_LIMITS.locatorChars. */
  locator: string | null;
  /** sha256 of the full locator text, present when `locator` was cut (the claim file keeps the full identity). */
  locatorDigest?: string;
  /** verifyBinding now; null for a claim that exists only at the merge base. */
  state: Verification["state"] | null;
  source: { state: string; cause: string; fileChanged: boolean | null } | null;
  model: { state: string; cause: string } | null;
  /** The claim file compared with its bytes at the merge base. */
  atBase: ClaimAtBase;
  /** Whether the bound file is among the candidate's changed files. */
  boundFileChanged: boolean;
  /** How the bound object figures in the model delta. */
  object: ObjectInChange;
  disputed: boolean;
};

export type SourceImpact = {
  seeds: { objectId: Id; kind: string; name: string; moduleId: Id | null; bindings: string[]; why: ("bound-file-changed" | "claim-added" | "claim-reasserted" | "claim-unresolved")[] }[];
  seedsTotal: number;
  modules: { id: Id; name: string; via: "seed" | "impacted" }[];
  crossModule: "yes" | "no" | "not-determined";
  contracts: { id: Id; name: string; moduleId: Id | null; via: "seed" | "impacted" }[];
  rules: { id: Id; name: string; moduleId: Id | null; via: "seed" | "impacted" }[];
  candidates: ImpactCandidate[];
  total: number;
  truncated: boolean;
  impactClass: "declared-model-context";
  note: string;
};

export type Reconciliation = {
  format: "vcv-reconciliation-1";
  base: {
    /** As given. */
    ref: string;
    commit: string;
    /** True when `ref` was the full commit ID itself (what a host should pass), false for a ref name resolved locally. */
    pinned: boolean;
    /** Where the candidate's changes are measured from (the base itself when the candidate contains it). */
    mergeBase: string;
    containedInCandidate: boolean;
    modelRevision: string | null;
  };
  candidate: { commit: string; branch: string | null; dirty: boolean; modelRevision: string; projectId: string; worktree: WorktreeState };
  model: {
    /** unchanged: same revision; extends: base line is a prefix; new-model: no .vcv/ at the base; rewritten: base history not a prefix, or a base revision's bytes changed. */
    lineage: "unchanged" | "extends" | "new-model" | "rewritten";
    introduced: { revision: string; changeId: string | null; derivation: string; approval: string }[];
    introducedTotal: number;
    integrity: { ok: boolean; errors: { code: string; message: string }[]; warnings: { code: string; message: string }[]; errorsTotal: number; warningsTotal: number; trust: string | null; authorization: string };
    delta: { from: string | null; changes: ObjectChange[]; total: number; truncated: boolean };
    impact: ProposalPreview["impact"];
  };
  source: { files: ChangedFile[]; total: number; truncated: boolean; unmapped: number | null };
  /**
   * Declared-model context for source changes, separate from the model delta's impact: the objects
   * whose claims point into changed code (seeds), and what the model says depends on them. It is
   * where to look, never evidence that behaviour changed. Null when no claim relates to a change,
   * or when the claims could not be read.
   */
  sourceImpact: SourceImpact | null;
  bindings: {
    /** False when the claim store could not be read: nothing below is an assessment, and no claim is inferred removed or unaffected. */
    available: boolean;
    problem?: string;
    items: ReconciledBinding[];
    total: number;
    truncated: boolean;
    unaffected: number | null;
    counts: Record<string, number>;
  };
  findings: ReconcileFinding[];
  findingsTotal: number;
  findingsTruncated: boolean;
  summary: {
    integrity: "ok" | "failed";
    structural: number;
    staleClaims: number;
    locatorProblems: number;
    removedClaims: number;
    unboundObjects: number;
    changedFiles: number;
    unmappedFiles: number;
    notChecked: number;
    bindingsAssessed: boolean;
  };
  /** The serialized size and whether lists were cut further to fit RECONCILE_LIMITS.bytes. */
  budget: { limit: number; bytes: number; shrunk: boolean };
  semantic: { observations: []; note: string };
  /** Always false: VCV compared pointers, fingerprints and model content, never what the code does. */
  implementationChecked: false;
  limits: string[];
};

const LIMITS = [
  "VCV checks the model history, claim shapes, locators and fingerprints, and the model delta. It does not read code for meaning: a resolved, fresh claim is not evidence that the code does what the model says.",
  "A changed file, a moved commit or a stale claim is not drift. Drift is a semantic judgement that an agent or a person makes with concrete source locations; this report gives them the places to look.",
  "Changed files that no claim points into are unmapped: VCV cannot relate them to the model at all.",
  "Structural impact candidates come from declared model references, not from code.",
  "The base is what the caller named. A ref name resolved in this checkout is caller-asserted; only a full commit ID supplied by the hosting service, in a check the candidate cannot edit, identifies the protected base.",
  "Source changes are measured from the merge base with the base, so changes that landed on the base after the branch point are not counted as the candidate's.",
];

const SEMANTIC_NOTE = "VCV makes no semantic observations. Agent-authored interpretations are added to the pre-merge report (M4.4) and labelled as claims.";

/** Compare the candidate checkout containing `path` with a protected base. Read-only, one observation. */
export function reconcile(path: string, input: unknown, hooks: ProposalHooks = {}): ProposalResult<Reconciliation> {
  const parsed = reconcileRequest.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "INVALID_REQUEST", message: "request does not match the reconciliation input schema", details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } };
  }
  const req = parsed.data as ReconcileRequest;
  return observed(path, hooks, (obs) => {
    const root = obs.status.root;
    const fail = (code: "UNKNOWN_COMMIT" | "STORE_ERROR", message: string) => failFinal<Reconciliation>({ code, message }, obs, hooks);
    if (!obs.status.git || !obs.commit) return fail("UNKNOWN_COMMIT", "the candidate is not a Git checkout with a commit: there is nothing to compare with a base");
    const baseCommit = resolveCommit(root, req.base);
    if (!baseCommit) return fail("UNKNOWN_COMMIT", `${req.base} is not a commit in this repository (fetch the base first)`);
    const mb = mergeBase(root, baseCommit, obs.commit);
    if (!mb) return fail("UNKNOWN_COMMIT", `${req.base} (${baseCommit.slice(0, 12)}) shares no history with HEAD`);

    // One snapshot of the working tree (changed and bound files, with bytes) before anything reads it.
    const claims = readClaims(root);
    const claimsProblem = claims.key.startsWith("unreadable:") ? claims.key.slice("unreadable:".length) : null;
    const tree = treeOf(root, obs.commit, mb, claims.entries);
    if (!tree) return fail("STORE_ERROR", "the working tree could not be compared with the merge base");
    // Every mutable input of the integrity result (attestations, trust list, changed .vcv/ files, the
    // trust source), read before checkIntegrity and again before answering.
    const evidence = evidenceKey(root, obs.status.storeDir, tree, req.trust);

    const integrity = checkIntegrity(root, { base: baseCommit, ...(req.trust ? { trust: req.trust } : {}), requireAttestation: !!req.requireAttestation });
    const baseModel = modelAt(root, baseCommit);
    const fromModel = mb === baseCommit ? baseModel : modelAt(root, mb);
    const verifications = new Map(claims.entries.map((e) => [e.bindingId, verifyBinding(root, e, obs.status)] as const));
    const baseClaims = claimsAt(root, mb);

    const data = assemble({ obs, req, baseCommit, mb, tree, integrity, baseModel, fromModel, entries: claims.entries, verifications, baseClaims, claimsProblem });
    const guard = {
      key: guardKey(claims.key, tree, baseCommit, evidence),
      again: () => {
        const c = readClaims(root);
        const head = headCommit(root);
        const t = head ? treeOf(root, head, mb, c.entries) : null;
        return guardKey(c.key, t, resolveCommit(root, req.base), evidenceKey(root, obs.status.storeDir, t, req.trust));
      },
    };
    const bounded = fitBudget(redact(data, root));
    if (!bounded) return failFinal({ code: "REPORT_TOO_LARGE", message: `the reconciliation report exceeds ${RECONCILE_LIMITS.bytes} bytes even with every list cut to one item; narrow the change or inspect it with vcv evidence` }, obs, hooks);
    return finish(obs, hooks, bounded, guard);
  });
}

const guardKey = (claimsKey: string, tree: Tree | null, base: string | null, evidence: string) =>
  canonicalJson([claimsKey, base, tree ? [tree.committed, tree.uncommitted, tree.state.digest] : "unreadable", evidence]);

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/**
 * The integrity check's mutable inputs as bytes: every attestation file, the checkout's trust
 * list, every changed `.vcv/` file (worktreeState does not read inside .vcv/), the approvals
 * directory listing, and the identity of the trust source (an external file's bytes, a ref's
 * commit). Read with the store's safe reader: no symlinks, no special files, bounded.
 */
function evidenceKey(root: string, storeDir: string, tree: Tree | null, trust: TrustSource | undefined): string {
  const rels = new Set<string>([REVIEWERS_FILE]);
  let listing: string[] | string;
  try {
    const st = lstatSync(join(storeDir, APPROVALS_DIR));
    listing = st.isSymbolicLink() || !st.isDirectory() ? `unsafe:${st.isSymbolicLink() ? "symlink" : "not-a-directory"}` : readdirSync(join(storeDir, APPROVALS_DIR)).sort();
  } catch (e) {
    listing = (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : `unreadable:${(e as NodeJS.ErrnoException).code}`;
  }
  if (Array.isArray(listing)) for (const f of listing) rels.add(`${APPROVALS_DIR}/${f}`);
  for (const p of tree?.changed ?? []) if (p.startsWith(`${VCV_DIR}/`)) rels.add(p.slice(VCV_DIR.length + 1));
  const files = [...rels].sort().map((rel) => {
    const f = readStoreFile(storeDir, rel, STORE_FILE_LIMITS.revision);
    return [rel, f.kind === "file" ? sha(f.bytes) : f.kind === "absent" ? "absent" : `unsafe:${f.problem}`];
  });
  let source: string | null = null;
  if (trust?.kind === "file") {
    try {
      source = `file:${sha(readPlainFile(trust.path, 1024 * 1024, "trust list"))}`;
    } catch (e) {
      source = `file-unreadable:${(e as Error).message}`;
    }
  } else if (trust?.kind === "git-ref") source = `ref:${resolveCommit(root, trust.ref)}`;
  else if (trust) source = trust.kind;
  return sha(canonicalJson([listing, files, source]));
}

const cutText = (t: string, max: number = RECONCILE_LIMITS.textChars) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

/**
 * Fit the serialized report into RECONCILE_LIMITS.bytes: halve the longest list (flagging it
 * truncated) until it fits, or give up (null) once every list is down to one item.
 */
function fitBudget(r: Reconciliation): Reconciliation | null {
  const size = (x: Reconciliation) => Buffer.byteLength(JSON.stringify(x, null, 2));
  let bytes = size(r);
  let shrunk = false;
  const lists: { get: () => unknown[]; set: (n: number) => void }[] = [
    { get: () => r.findings, set: (n) => ((r.findings = r.findings.slice(0, n)), (r.findingsTruncated = true)) },
    { get: () => r.bindings.items, set: (n) => ((r.bindings.items = r.bindings.items.slice(0, n)), (r.bindings.truncated = true)) },
    { get: () => r.source.files, set: (n) => ((r.source.files = r.source.files.slice(0, n)), (r.source.truncated = true)) },
    { get: () => r.model.delta.changes, set: (n) => ((r.model.delta.changes = r.model.delta.changes.slice(0, n)), (r.model.delta.truncated = true)) },
    { get: () => r.model.impact?.candidates ?? [], set: (n) => r.model.impact && ((r.model.impact.candidates = r.model.impact.candidates.slice(0, n)), (r.model.impact.truncated = true)) },
    { get: () => r.sourceImpact?.candidates ?? [], set: (n) => r.sourceImpact && ((r.sourceImpact.candidates = r.sourceImpact.candidates.slice(0, n)), (r.sourceImpact.truncated = true)) },
    { get: () => r.sourceImpact?.seeds ?? [], set: (n) => r.sourceImpact && (r.sourceImpact.seeds = r.sourceImpact.seeds.slice(0, n)) },
    { get: () => r.model.introduced, set: (n) => (r.model.introduced = r.model.introduced.slice(0, n)) },
    { get: () => r.model.integrity.errors, set: (n) => (r.model.integrity.errors = r.model.integrity.errors.slice(0, n)) },
    { get: () => r.model.integrity.warnings, set: (n) => (r.model.integrity.warnings = r.model.integrity.warnings.slice(0, n)) },
  ];
  while (bytes > RECONCILE_LIMITS.bytes) {
    const longest = lists.reduce((a, b) => (b.get().length > a.get().length ? b : a));
    const n = longest.get().length;
    if (n <= 1) return null;
    longest.set(Math.floor(n / 2));
    shrunk = true;
    r.budget = { limit: RECONCILE_LIMITS.bytes, bytes: 0, shrunk };
    bytes = size(r);
  }
  // The recorded size is the size with this field filled in (a fixed-width number would differ by a few bytes at most).
  r.budget = { limit: RECONCILE_LIMITS.bytes, bytes, shrunk };
  r.budget.bytes = size(r);
  return r;
}

// ---- observation pieces ---------------------------------------------------------------------

type Tree = { committed: string[]; uncommitted: string[]; changed: string[]; state: WorktreeState };

/** Changed files since the merge base, split into committed and uncommitted, plus the bytes of those and every bound file. */
function treeOf(root: string, head: string, mb: string, entries: readonly ClaimEntry[]): Tree | null {
  const committed = changedFilesBetween(root, mb, head);
  const uncommitted = changedFilesSince(root, head);
  if (!committed || !uncommitted) return null;
  const changed = [...new Set([...committed, ...uncommitted])].sort();
  const bound = entries.map((e) => e.claim?.locator.path).filter((p): p is string => !!p);
  return { committed, uncommitted, changed, state: worktreeState(root, [...changed, ...bound]) };
}

type BaseModel = { revision: string; history: string[]; model: Model } | { absent: true } | { unreadable: string };

/** The model `.vcv/HEAD` names at a commit, read from Git objects only. */
function modelAt(root: string, commit: string): BaseModel {
  const head = fileAtCommit(root, commit, `${VCV_DIR}/HEAD`, STORE_FILE_LIMITS.head);
  if (!head) return filesAtCommit(root, commit, VCV_DIR).length ? { unreadable: `${VCV_DIR}/HEAD is missing or too large` } : { absent: true };
  let revision: string;
  let history: string[];
  try {
    const h = JSON.parse(head.toString("utf8")) as { revision?: unknown; history?: unknown };
    if (typeof h.revision !== "string" || persistedIdProblem(h.revision) || !Array.isArray(h.history) || !h.history.every((x) => typeof x === "string")) throw new Error("bad");
    revision = h.revision;
    history = h.history as string[];
  } catch {
    return { unreadable: `${VCV_DIR}/HEAD is not a valid HEAD` };
  }
  const bytes = fileAtCommit(root, commit, `${VCV_DIR}/revisions/${revision}.yaml`, STORE_FILE_LIMITS.revision);
  if (!bytes) return { unreadable: `revision ${revision} is missing or too large` };
  const loaded = loadModel(bytes.toString("utf8"));
  if (!loaded.model) return { unreadable: `revision ${revision} is not a valid model` };
  return { revision, history, model: loaded.model };
}

/** Claim file digests at a commit, by binding ID. */
function claimsAt(root: string, commit: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = `${VCV_DIR}/bindings/`;
  for (const rel of filesAtCommit(root, commit, `${VCV_DIR}/bindings`)) {
    if (!rel.startsWith(dir) || !rel.endsWith(".json") || rel.slice(dir.length).includes("/")) continue;
    const bytes = fileAtCommit(root, commit, rel, MAX_CLAIM_BYTES);
    out.set(rel.slice(dir.length, -".json".length), bytes ? createHash("sha256").update(bytes).digest("hex") : "unreadable");
  }
  return out;
}

function areaOf(path: string): FileArea {
  if (path.startsWith(`${VCV_DIR}/`)) {
    const sub = path.slice(VCV_DIR.length + 1);
    if (sub.startsWith("bindings/")) return "vcv-bindings";
    if (sub === "HEAD" || sub.startsWith("revisions/") || sub.startsWith("changes/") || sub.startsWith("approvals/")) return "vcv-model";
    return "vcv-other";
  }
  return /(^|\/)(test|tests|__tests__)\/|[.-](test|spec)\.[cm]?[jt]sx?$/.test(path) ? "test" : "source";
}

// ---- assembly -------------------------------------------------------------------------------

type Parts = {
  obs: Observation;
  req: ReconcileRequest;
  baseCommit: string;
  mb: string;
  tree: Tree;
  integrity: IntegrityReport;
  baseModel: BaseModel;
  fromModel: BaseModel;
  entries: ClaimEntry[];
  verifications: Map<string, Verification>;
  baseClaims: Map<string, string>;
  /** Set when the claim store could not be read at all (unsafe or unreadable bindings directory). */
  claimsProblem: string | null;
};

function assemble(p: Parts): Reconciliation {
  const { obs, tree, integrity } = p;
  const findings: ReconcileFinding[] = [];
  // Messages quote locators, causes and paths that can be long: every finding's text is bounded.
  const add = (f: ReconcileFinding) => findings.push({ ...f, message: cutText(f.message), checked: cutText(f.checked) });
  const claimsReadable = p.claimsProblem === null;
  const candidateModel = obs.model;
  const candidateRev = candidateModel.project.modelRevision;

  // Model line and delta.
  const baseRev = "model" in p.baseModel ? p.baseModel.revision : null;
  const lineage: Reconciliation["model"]["lineage"] =
    "absent" in p.baseModel ? "new-model" : !("model" in p.baseModel) || integrity.problems.some((x) => x.code === "BASE_HISTORY_REWRITTEN" || x.code === "BASE_REVISION_CHANGED") ? "rewritten" : baseRev === candidateRev ? "unchanged" : "extends";
  const from = "model" in p.fromModel ? p.fromModel : null;
  const allChanges = from ? diffModels(from.model, candidateModel) : [];
  const impact = from && allChanges.length ? impactOf(from.model, candidateModel, allChanges, RECONCILE_LIMITS.candidates) : null;
  const inChange = new Map<Id, ObjectInChange>();
  for (const c of allChanges) inChange.set(c.id, c.change);
  for (const c of impact?.candidates ?? []) if (!inChange.has(c.id)) inChange.set(c.id, "impacted");
  const inModel = new Set(buildIndex(candidateModel).byId.keys());
  const objectState = (id: Id): ObjectInChange => inChange.get(id) ?? (inModel.has(id) ? "unchanged" : "not-in-model");

  for (const x of integrity.problems) {
    add({ code: x.code, category: "integrity", basis: "checked", related: true, message: x.message, checked: "the .vcv/ history against the base (derivation replay, records, attestations)", ...(x.revision ? { revision: x.revision } : {}), ...(x.changeId ? { changeId: x.changeId } : {}) });
  }
  if ("unreadable" in p.baseModel) add({ code: "BASE_MODEL_UNREADABLE", category: "integrity", basis: "checked", related: true, message: `the base's model cannot be read: ${p.baseModel.unreadable}`, checked: `${VCV_DIR}/ at ${p.baseCommit.slice(0, 12)} (Git objects)` });
  if (lineage === "new-model") add({ code: "MODEL_INTRODUCED", category: "source", basis: "observed", related: true, message: `the base has no ${VCV_DIR}/; the candidate introduces the whole model (${candidateRev}), whose origin is not provable`, checked: `${VCV_DIR}/ at ${p.baseCommit.slice(0, 12)}` });
  if (!from && !("absent" in p.fromModel) && p.mb !== p.baseCommit) add({ code: "DELTA_UNAVAILABLE", category: "unsupported", basis: "not-checked", related: true, message: "the model at the merge base cannot be read, so no model delta is reported", checked: `${VCV_DIR}/ at ${p.mb.slice(0, 12)}` });

  // Source files.
  const committed = new Set(tree.committed);
  const uncommitted = new Set(tree.uncommitted);
  const byFile = new Map<string, { bindings: string[]; objects: Set<Id> }>();
  for (const e of p.entries) {
    if (!e.claim) continue;
    const f = byFile.get(e.claim.locator.path) ?? { bindings: [], objects: new Set<Id>() };
    f.bindings.push(e.bindingId);
    f.objects.add(e.claim.modelObjectId);
    byFile.set(e.claim.locator.path, f);
  }
  const changedSet = new Set(tree.changed);
  const files: ChangedFile[] = tree.changed.map((path) => {
    const f = byFile.get(path);
    return { path, area: areaOf(path), committed: committed.has(path), uncommitted: uncommitted.has(path), bindings: f ? [...f.bindings].sort() : [], objectIds: f ? [...f.objects].sort() : [] };
  });
  const code = files.filter((f) => f.area === "source" || f.area === "test");
  // Without readable claims nothing is known to be mapped or unmapped.
  const unmapped = claimsReadable ? code.filter((f) => f.bindings.length === 0) : [];
  if (!claimsReadable) {
    add({
      code: "CLAIM_STORE_UNREADABLE",
      category: "binding",
      basis: "not-checked",
      related: true,
      message: `the binding claims could not be read (${p.claimsProblem}); no claim was verified, none is reported removed or unaffected, and which changed files are mapped is unknown`,
      checked: `${VCV_DIR}/bindings/ in the working tree`,
    });
  }
  for (const f of code) {
    if (!f.bindings.length) continue;
    add({
      code: "BOUND_FILE_CHANGED",
      category: "source",
      basis: "observed",
      related: true,
      path: f.path,
      objectIds: f.objectIds,
      message: `${f.path} changed${f.uncommitted ? " (uncommitted edits included)" : ""}; claims ${f.bindings.join(", ")} point into it. A changed file is not drift: see each claim's freshness.`,
      checked: `the file list between ${p.mb.slice(0, 12)} and the working tree`,
    });
  }
  if (unmapped.length) {
    add({
      code: "UNMAPPED_CHANGES",
      category: "unsupported",
      basis: "not-checked",
      related: true,
      message: `${unmapped.length} changed file(s) outside .vcv/ are not pointed at by any claim, so VCV cannot relate them to the model: ${unmapped.slice(0, RECONCILE_LIMITS.paths).map((f) => f.path).join(", ")}${unmapped.length > RECONCILE_LIMITS.paths ? ", …" : ""}`,
      checked: "binding claim locators against the changed file list",
    });
  }
  if (tree.uncommitted.length) {
    add({ code: "UNCOMMITTED_CHANGES", category: "source", basis: "observed", related: true, message: `${tree.uncommitted.length} path(s) differ from HEAD; this report describes those working-tree bytes (candidate.worktree), not only commit ${obs.commit!.slice(0, 12)}`, checked: "git status against HEAD" });
  }
  if (p.mb !== p.baseCommit) {
    add({ code: "BASE_NOT_CONTAINED", category: "source", basis: "observed", related: true, message: `the candidate does not contain the base ${p.baseCommit.slice(0, 12)}; its changes are measured from the merge base ${p.mb.slice(0, 12)}. Update the branch before merging.`, checked: "git merge-base" });
  }

  // Bindings.
  const rows: ReconciledBinding[] = [];
  const ids = [...new Set([...p.entries.map((e) => e.bindingId), ...p.baseClaims.keys()])].sort();
  const entryOf = new Map(p.entries.map((e) => [e.bindingId, e] as const));
  const claimsOn = new Map<Id, string[]>();
  for (const e of p.entries) if (e.claim) claimsOn.set(e.claim.modelObjectId, [...(claimsOn.get(e.claim.modelObjectId) ?? []), e.bindingId]);
  let unaffected = 0;
  const counts: Record<string, number> = {};
  for (const id of claimsReadable ? ids : []) {
    const e = entryOf.get(id);
    const atBaseDigest = p.baseClaims.get(id);
    const atBase: ClaimAtBase = !e ? "removed" : atBaseDigest === undefined ? "added" : atBaseDigest === e.digest ? "unchanged" : "reasserted";
    if (!e) {
      rows.push({ bindingId: id, modelObjectId: null, relation: null, locator: null, state: null, source: null, model: null, atBase, boundFileChanged: false, object: "not-in-model", disputed: false });
      add({ code: "CLAIM_REMOVED", category: "binding", basis: "observed", related: true, bindingId: id, message: `claim ${id} exists at the merge base but was removed here; whatever it located is no longer bound`, checked: `${VCV_DIR}/bindings/${id}.json at ${p.mb.slice(0, 12)} and in the working tree` });
      continue;
    }
    const v = p.verifications.get(id)!;
    const c = e.claim;
    counts[v.state] = (counts[v.state] ?? 0) + 1;
    const object = c ? objectState(c.modelObjectId) : "not-in-model";
    const boundFileChanged = !!c && changedSet.has(c.locator.path);
    const related = atBase !== "unchanged" || boundFileChanged || (object !== "unchanged" && object !== "not-in-model") || (!!c && !inModel.has(c.modelObjectId));
    const row: ReconciledBinding = {
      bindingId: id,
      modelObjectId: c?.modelObjectId ?? null,
      relation: c?.relation ?? null,
      ...locatorText(c ? formatLocator(c.locator) : null),
      state: v.state,
      source: v.source ? { state: v.source.state, cause: cutText(v.source.cause), fileChanged: v.source.fileChanged } : null,
      model: v.model ? { state: v.model.state, cause: cutText(v.model.cause) } : null,
      atBase,
      boundFileChanged,
      object,
      disputed: Boolean(v.disputed),
    };
    if (related || v.state !== "resolved") rows.push(row);
    else unaffected++;
    bindingFindings(row, v, add, related);
  }

  // Declared-model context for the source side: objects whose claims point into changed code.
  const sourceImpact = claimsReadable ? sourceImpactOf(candidateModel, rows) : null;

  // Changed model objects whose code nothing locates (unknown when the claims cannot be read).
  for (const ch of claimsReadable ? allChanges : []) {
    if (ch.change === "removed" || ch.kind === "project") continue;
    if (claimsOn.has(ch.id)) continue;
    add({ code: "OBJECT_UNBOUND", category: "coverage", basis: "observed", related: true, objectIds: [ch.id], message:
        ch.kind === "criterion"
          ? `criterion ${ch.id} was ${ch.change} by the candidate's model change, and no test case is mapped to it (a \`tests\` claim on the criterion; see vcv criteria)`
          : `${ch.kind} ${ch.id} was ${ch.change} by the candidate's model change, and no binding claim locates its code`, checked: "binding claims against the model delta" });
  }

  const cut = <T>(xs: T[], n: number) => ({ items: xs.slice(0, n), total: xs.length, truncated: xs.length > n });
  const shownFiles = cut(files, RECONCILE_LIMITS.files);
  const shownRows = cut(rows, RECONCILE_LIMITS.bindings);
  const shownChanges = cut(allChanges, RECONCILE_LIMITS.changes);
  const introduced = integrity.revisions.filter((r) => r.introduced).map((r) => ({ revision: r.revision, changeId: r.changeId, derivation: r.derivation, approval: r.approval.state }));
  const problem = (x: { code: string; message: string }) => ({ code: x.code, message: cutText(x.message) });
  const errors = integrity.problems.filter((x) => x.severity === "error").map(problem);
  const warnings = integrity.problems.filter((x) => x.severity === "warning").map(problem);
  if (shownFiles.truncated || shownRows.truncated || shownChanges.truncated) {
    add({ code: "LIST_TRUNCATED", category: "unsupported", basis: "not-checked", related: true, message: `lists were cut at their limits (files ${RECONCILE_LIMITS.files}, bindings ${RECONCILE_LIMITS.bindings}, model changes ${RECONCILE_LIMITS.changes}); the summary counts everything`, checked: "list sizes" });
  }
  const order: Record<FindingCategory, number> = { integrity: 0, structural: 1, binding: 2, coverage: 3, source: 4, unsupported: 5 };
  findings.sort((a, b) => order[a.category] - order[b.category] || (a.related === b.related ? 0 : a.related ? -1 : 1));
  const shownFindings = cut(findings, RECONCILE_LIMITS.findings);
  const n = (pred: (f: ReconcileFinding) => boolean) => findings.filter(pred).length;

  return {
    format: "vcv-reconciliation-1",
    base: {
      ref: p.req.base,
      commit: p.baseCommit,
      pinned: p.req.base === p.baseCommit,
      mergeBase: p.mb,
      containedInCandidate: p.mb === p.baseCommit && isAncestor(obs.status.root, p.baseCommit, obs.commit!),
      modelRevision: baseRev,
    },
    candidate: { commit: obs.commit!, branch: obs.status.git?.branch ?? null, dirty: tree.uncommitted.length > 0, modelRevision: candidateRev, projectId: candidateModel.project.id, worktree: tree.state },
    model: {
      lineage,
      introduced: introduced.slice(0, RECONCILE_LIMITS.revisions),
      introducedTotal: introduced.length,
      integrity: {
        ok: integrity.ok,
        errors: errors.slice(0, RECONCILE_LIMITS.integrityItems),
        warnings: warnings.slice(0, RECONCILE_LIMITS.integrityItems),
        errorsTotal: errors.length,
        warningsTotal: warnings.length,
        trust: integrity.trust ? `${integrity.trust.source}; ${integrity.trust.anchor}` : null,
        authorization: integrity.authorization,
      },
      delta: { from: from?.revision ?? null, changes: shownChanges.items, total: shownChanges.total, truncated: shownChanges.truncated },
      impact,
    },
    source: { files: shownFiles.items, total: shownFiles.total, truncated: shownFiles.truncated, unmapped: claimsReadable ? unmapped.length : null },
    sourceImpact,
    bindings: claimsReadable
      ? { available: true, items: shownRows.items, total: shownRows.total, truncated: shownRows.truncated, unaffected, counts }
      : { available: false, problem: cutText(p.claimsProblem!), items: [], total: 0, truncated: false, unaffected: null, counts: {} },
    findings: shownFindings.items,
    findingsTotal: shownFindings.total,
    findingsTruncated: shownFindings.truncated,
    summary: {
      integrity: integrity.ok ? "ok" : "failed",
      structural: n((f) => f.category === "structural"),
      staleClaims: n((f) => f.code === "CLAIM_STALE"),
      locatorProblems: n((f) => f.code === "LOCATOR_MISSING" || f.code === "LOCATOR_AMBIGUOUS"),
      removedClaims: n((f) => f.code === "CLAIM_REMOVED"),
      unboundObjects: n((f) => f.code === "OBJECT_UNBOUND"),
      changedFiles: files.length,
      unmappedFiles: unmapped.length,
      notChecked: n((f) => f.basis === "not-checked"),
      bindingsAssessed: claimsReadable,
    },
    budget: { limit: RECONCILE_LIMITS.bytes, bytes: 0, shrunk: false },
    semantic: { observations: [], note: SEMANTIC_NOTE },
    implementationChecked: false,
    limits: LIMITS,
  };
}

function bindingFindings(row: ReconciledBinding, v: Verification, add: (f: ReconcileFinding) => void, related: boolean) {
  const id = row.bindingId;
  const objectIds = row.modelObjectId ? [row.modelObjectId] : undefined;
  const base = { bindingId: id, related, ...(objectIds ? { objectIds } : {}), ...(v.claim ? { path: v.claim.locator.path } : {}) };
  const at = row.locator ?? id;
  if (v.state === "invalid") {
    add({ ...base, code: "CLAIM_INVALID", category: "binding", basis: "checked", message: `claim ${id} cannot be read: ${v.problem ?? "unreadable"}`, checked: `${VCV_DIR}/bindings/${id}.json against the claim format` });
    return;
  }
  if (row.object === "not-in-model" || row.model?.state === "removed") {
    add({ ...base, code: "CLAIM_ON_MISSING_OBJECT", category: "structural", basis: "checked", message: `claim ${id} binds ${row.modelObjectId}, which the candidate's approved model does not contain: the claim and the model contradict each other`, checked: "the claim's model object ID against the candidate model" });
    return;
  }
  if (v.state === "missing") add({ ...base, code: "LOCATOR_MISSING", category: "binding", basis: "checked", message: `claim ${id} (${row.modelObjectId}) points at ${at}, which does not resolve: ${v.locator?.detail ?? ""}`.trim(), checked: "the locator against the working tree (TypeScript resolver)" });
  else if (v.state === "ambiguous") add({ ...base, code: "LOCATOR_AMBIGUOUS", category: "binding", basis: "checked", message: `claim ${id} (${row.modelObjectId}) matches more than one artifact at ${at}: ${v.locator?.detail ?? ""}`.trim(), checked: "the locator against the working tree (TypeScript resolver)" });
  else if (v.state === "stale") {
    const why = [row.source?.state === "changed" ? `code: ${row.source.cause}` : null, row.model && row.model.state !== "unchanged" ? `model: ${row.model.cause}` : null].filter(Boolean).join("; ");
    add({ ...base, code: "CLAIM_STALE", category: "binding", basis: "checked", message: `claim ${id} (${row.modelObjectId} at ${at}) is stale (${why}). The code or object moved since the claim; whether it still does what the model says is for an agent or a person to judge`, checked: "recorded fingerprints against the working tree and the model object at the claim's revision" });
  } else if (v.state === "unchecked" || v.state === "indeterminate") {
    add({ ...base, code: "CLAIM_NOT_CHECKED", category: "unsupported", basis: "not-checked", message: `claim ${id} (${row.modelObjectId} at ${at}) is ${v.state}: ${v.state === "unchecked" ? v.locator?.detail ?? "" : [row.source?.cause, row.model?.cause].filter(Boolean).join("; ")}`, checked: "what the resolver supports" });
  }
  if (row.disputed) add({ ...base, code: "CLAIM_DISPUTED", category: "binding", basis: "observed", message: `claim ${id} carries a recorded dispute`, checked: "the claim file" });
}

/** A locator for display: cut at RECONCILE_LIMITS.locatorChars, with the digest of the full text when cut. */
function locatorText(text: string | null): Pick<ReconciledBinding, "locator" | "locatorDigest"> {
  if (text === null || text.length <= RECONCILE_LIMITS.locatorChars) return { locator: text };
  return { locator: cutText(text, RECONCILE_LIMITS.locatorChars), locatorDigest: sha(text) };
}

/**
 * Seeds: model objects whose claims point into changed code, or whose claims were added,
 * reasserted or no longer resolve. Impact: what the declared model references say depends on
 * them (@vcv/query analyzeImpact on the candidate model). Context for where to look, labelled as
 * such; never evidence that behaviour changed.
 */
function sourceImpactOf(model: Model, rows: readonly ReconciledBinding[]): SourceImpact | null {
  const index = buildIndex(model).byId;
  const seedMap = new Map<Id, { bindings: Set<string>; why: Set<SourceImpact["seeds"][number]["why"][number]> }>();
  for (const r of rows) {
    if (!r.modelObjectId || !index.has(r.modelObjectId) || r.state === null) continue;
    const why: SourceImpact["seeds"][number]["why"][number][] = [];
    if (r.boundFileChanged) why.push("bound-file-changed");
    if (r.atBase === "added") why.push("claim-added");
    if (r.atBase === "reasserted") why.push("claim-reasserted");
    if (r.state === "missing" || r.state === "ambiguous") why.push("claim-unresolved");
    if (!why.length) continue;
    const s = seedMap.get(r.modelObjectId) ?? { bindings: new Set<string>(), why: new Set() };
    s.bindings.add(r.bindingId);
    for (const w of why) s.why.add(w);
    seedMap.set(r.modelObjectId, s);
  }
  if (!seedMap.size) return null;
  const ids = [...seedMap.keys()].sort();
  const seeds = ids.map((id) => {
    const e = index.get(id)!;
    const s = seedMap.get(id)!;
    return { objectId: id, kind: e.kind, name: cutText(e.name, 200), moduleId: moduleOf(model, id), bindings: [...s.bindings].sort(), why: [...s.why].sort() };
  });
  const seen = new Map<Id, ImpactCandidate>();
  let truncated = false;
  const api = createQueryApi({ current: () => model });
  for (let i = 0; i < ids.length; i += QUERY_LIMITS.impact.maxSeeds) {
    const r = api.analyzeImpact({ ids: ids.slice(i, i + QUERY_LIMITS.impact.maxSeeds), maxResults: RECONCILE_LIMITS.candidates });
    if (!r.ok) continue;
    truncated ||= r.data.truncated;
    for (const c of r.data.candidates) if (!seedMap.has(c.id) && !seen.has(c.id)) seen.set(c.id, c);
  }
  const candidates = [...seen.values()].sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1));
  const nameOf = (id: Id) => cutText(index.get(id)?.name ?? id, 200);
  const modules = new Map<Id, SourceImpact["modules"][number]>();
  const contracts = new Map<Id, SourceImpact["contracts"][number]>();
  const rules = new Map<Id, SourceImpact["rules"][number]>();
  const note = (id: Id, kind: string, moduleId: Id | null, via: "seed" | "impacted") => {
    if (kind === "contract" && !contracts.has(id)) contracts.set(id, { id, name: nameOf(id), moduleId, via });
    if (kind === "rule" && !rules.has(id)) rules.set(id, { id, name: nameOf(id), moduleId, via });
    if (kind === "module" && !modules.has(id)) modules.set(id, { id, name: nameOf(id), via });
    if (moduleId && !modules.has(moduleId)) modules.set(moduleId, { id: moduleId, name: nameOf(moduleId), via });
  };
  for (const s of seeds) note(s.objectId, s.kind, s.moduleId, "seed");
  for (const c of candidates) note(c.id, c.kind, c.moduleId ?? moduleOf(model, c.id), "impacted");
  const byId = <T extends { id: Id }>(m: Map<Id, T>) => [...m.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const cutList = truncated || candidates.length > RECONCILE_LIMITS.candidates;
  return {
    seeds: seeds.slice(0, RECONCILE_LIMITS.seeds),
    seedsTotal: seeds.length,
    modules: byId(modules),
    crossModule: modules.size > 1 ? "yes" : cutList ? "not-determined" : "no",
    contracts: byId(contracts),
    rules: byId(rules),
    candidates: candidates.slice(0, RECONCILE_LIMITS.candidates),
    total: candidates.length,
    truncated: cutList,
    impactClass: "declared-model-context",
    note: "Objects whose binding claims point into changed code, and what the declared model references say depends on them. Where to look, not evidence that behaviour changed; unmapped changed files contribute nothing here.",
  };
}
