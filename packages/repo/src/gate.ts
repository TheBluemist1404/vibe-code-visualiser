// The pre-merge reconciliation report and policy gate (Issue #22, M4.4).
//
// One deterministic, reviewer-facing answer for a pull request: may this candidate merge into the
// protected base? It combines what earlier slices already establish, and adds nothing VCV cannot
// check:
//
//   integrity   the model history against the base's history and trust list (checkIntegrity,
//               always pinned to the base commit and with attestation required);
//   structure   checked contradictions between claims and the approved model (M4.1);
//   bindings    stale, missing, ambiguous, removed claims (M4.1): facts about pointers, never drift;
//   criteria    every approved criterion's mapped test cases and their results in runs of this exact
//               candidate (M4.2, M4.3). Runs captured here, for a caller holding `tests:observe`,
//               are host-observed; every imported record is a claim;
//   agents      bounded, agent-authored semantic observations ("this code no longer notifies on
//               rejection"). VCV checks that what they point at exists (model objects, files and
//               lines, test cases) and labels them claims. It never confirms an interpretation.
//
// A policy maps each kind of outcome to block / warn / off. The defaults block invalid history,
// checked structural contradictions and any required criterion without a host-observed pass; they
// warn for optional criteria, binding upkeep, coverage gaps and agent observations. `unknown` is
// never `passed`. Integrity is not configurable. The policy comes from the host: a file it supplies,
// or a path read from the BASE commit's objects, never from the candidate's working tree.
//
// The gate runs no tests and executes nothing from the candidate. One observation: the candidate's
// identity is read before anything else and again before answering (STATE_CHANGED).
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { buildIndex } from "@vcv/ir";
import type { Id } from "@vcv/ir";
import { canonicalJson } from "@vcv/core";
import { criteriaEvidence } from "./criteria.ts";
import type { CriteriaReport, CriterionEvidence, RunSummary } from "./criteria.ts";
import { MAX_CLAIM_BYTES } from "./bindings.ts";
import {
  currentBranchRef,
  entryAtCommit,
  fileAtCommit,
  filesAtCommit,
  findWorkTreeRoot,
  headCommit,
  mergeBase,
  resolveCommit,
} from "./git.ts";
import { redact } from "./handoff.ts";
import { caseKey } from "./junit.ts";
import { pathProblem, resolveInside } from "./locator.ts";
import { finish, observed } from "./proposals.ts";
import type { Observation, ProposalError, ProposalHooks, ProposalResult } from "./proposals.ts";
import { worktreeState } from "./worktree.ts";
import { reconcile } from "./reconcile.ts";
import { resolveLocator } from "./resolver.ts";
import type { Reconciliation, ReconcileFinding } from "./reconcile.ts";
import { candidateIdentityOf, captureTestRun, identityDigest } from "./testruns.ts";
import type { TestRunHost, TestRunRecord } from "./testruns.ts";

export const GATE_LIMITS = {
  reasons: 300,
  criteria: 200,
  observations: 50,
  refsPerObservation: 20,
  statementChars: 2000,
  messageChars: 1000,
  policyBytes: 64 * 1024,
  observationsBytes: 1024 * 1024,
  /** Lines are checked against files up to this size; larger files are reported as not checked. */
  lineCheckBytes: 4 * 1024 * 1024,
  requireEvidence: 100,
  /** Criteria evaluated per call when the full criteria report had to be cut. */
  criteriaBatch: 25,
  bytes: 512 * 1024,
  /**
   * The .vcv/ store is hashed whole into the snapshot (entries, nesting depth, total file bytes).
   * Past any of them the gate refuses (SOURCE_IDENTITY_UNAVAILABLE) rather than decide on a store
   * it did not fully observe.
   */
  storeEntries: 50_000,
  storeDepth: 32,
  storeBytes: 256 * 1024 * 1024,
} as const;

/** The store walk's bounds; GATE_LIMITS by default, lower ones only make the gate refuse sooner. */
export type StoreBudget = { entries: number; depth: number; bytes: number };
const DEFAULT_STORE_BUDGET: StoreBudget = {
  entries: GATE_LIMITS.storeEntries,
  depth: GATE_LIMITS.storeDepth,
  bytes: GATE_LIMITS.storeBytes,
};
/** Options for tests and hosts; each budget is clamped to GATE_LIMITS (a host can only lower it). */
export type GateOptions = { storeBudget?: Partial<StoreBudget> };
const budgetOf = (o: GateOptions): StoreBudget => ({
  entries: Math.min(o.storeBudget?.entries ?? Infinity, DEFAULT_STORE_BUDGET.entries),
  depth: Math.min(o.storeBudget?.depth ?? Infinity, DEFAULT_STORE_BUDGET.depth),
  bytes: Math.min(o.storeBudget?.bytes ?? Infinity, DEFAULT_STORE_BUDGET.bytes),
});

// ---- policy ------------------------------------------------------------------------------------

const level = z.enum(["block", "warn", "off"]);
/** Settings that may be lowered to warn but never switched off. */
const requiredLevel = z.enum(["block", "warn"]);
/**
 * Required criteria are not configurable here (M4.4 review): whether a criterion's evidence is
 * mandatory is approved intent in the model, changed only through an M3 proposal and a separate
 * human approval. Every outcome of a required criterion other than a host-observed pass blocks.
 */
export const REQUIRED_EVIDENCE = {
  failed: "block",
  stale: "block",
  missing: "block",
  unknown: "block",
  unverified: "block",
  claimed: "block",
} as const;
const optionalEvidence = z
  .object({
    failed: level.default("warn"),
    stale: level.default("warn"),
    missing: level.default("warn"),
    unknown: level.default("warn"),
    unverified: level.default("warn"),
    claimed: level.default("warn"),
  })
  .strict()
  .prefault({});

export const gatePolicySchema = z
  .object({
    format: z.literal("vcv-policy-1"),
    /** Optional criteria likewise. */
    optional: optionalEvidence,
    /** Checked contradictions between claims and the approved model (CLAIM_ON_MISSING_OBJECT). */
    structural: requiredLevel.default("block"),
    /** Claim upkeep: stale, missing or ambiguous locators, removed or invalid claims. related: about something the candidate changed. */
    bindings: z
      .object({ related: level.default("warn"), unrelated: level.default("warn") })
      .strict()
      .prefault({}),
    /** An object the candidate added or changed in the model has no claim (OBJECT_UNBOUND). */
    coverage: level.default("warn"),
    /** What VCV could not check: unmapped changed files, unchecked selectors, cut lists. */
    unsupported: level.default("warn"),
    /** The candidate does not contain the base (an out-of-date branch). */
    baseNotContained: level.default("warn"),
    /**
     * A test-case mapping of a criterion was added or reasserted by the candidate, or its test file
     * changed: no approval is needed for that, so a reviewer should see that the test still checks
     * the criterion.
     */
    mappingChanged: level.default("warn"),
    /** The model has no criteria at all: test evidence gates nothing. */
    noCriteria: level.default("warn"),
    /** Agent-authored observations: always claims. */
    observations: z
      .object({
        contradiction: level.default("warn"),
        concern: level.default("warn"),
        invalidReferences: level.default("warn"),
      })
      .strict()
      .prefault({}),
    /** The candidate edits the policy the gate reads from the base: it applies only after the merge. */
    policyChanged: requiredLevel.default("warn"),
    /**
     * Objects that need criterion evidence whenever a change touches them: at least one REQUIRED
     * criterion that verifies the object must have a host-observed pass, or the gate blocks.
     */
    requireEvidence: z
      .array(z.object({ object: z.string().min(1).max(256), reason: z.string().max(300).optional() }).strict())
      .max(GATE_LIMITS.requireEvidence)
      .default([]),
  })
  .strict();
export type GatePolicy = z.infer<typeof gatePolicySchema>;
export const DEFAULT_POLICY: GatePolicy = gatePolicySchema.parse({ format: "vcv-policy-1" });

// ---- agent observations -------------------------------------------------------------------------

const portablePath = z.string().min(1).max(1000);
export const observationsSchema = z
  .object({
    format: z.literal("vcv-observations-1"),
    observations: z
      .array(
        z
          .object({
            id: z.string().regex(/^obs-[a-z0-9][a-z0-9-]{0,62}$/),
            /** contradiction: the agent asserts the code disagrees with approved intent; concern: it may; note: context only. */
            kind: z.enum(["contradiction", "concern", "note"]),
            statement: z.string().min(1).max(GATE_LIMITS.statementChars),
            /** Model objects (and criteria) the observation is about. */
            objects: z.array(z.string().min(1).max(256)).max(GATE_LIMITS.refsPerObservation).default([]),
            /** Concrete source locations. A contradiction needs at least one. */
            locations: z
              .array(
                z
                  .object({
                    path: portablePath,
                    startLine: z.number().int().min(1).optional(),
                    endLine: z.number().int().min(1).optional(),
                  })
                  .strict(),
              )
              .max(GATE_LIMITS.refsPerObservation)
              .default([]),
            /** Test cases that support it, by file and full title (as in a `#test:` locator). */
            tests: z
              .array(z.object({ path: portablePath, name: z.string().min(1).max(1000) }).strict())
              .max(GATE_LIMITS.refsPerObservation)
              .default([]),
            /** What the agent proposes: fix the code, submit a model proposal (M3), or have a person inspect. */
            resolution: z.enum(["fix-code", "submit-model-proposal", "inspect", "none"]),
            author: z.string().min(1).max(100).optional(),
          })
          .strict(),
      )
      .max(GATE_LIMITS.observations),
  })
  .strict();

export type VerifiedObservation = {
  id: string;
  kind: "contradiction" | "concern" | "note";
  /** Always a claim: VCV checked the references, not the interpretation. */
  basis: "claim";
  statement: string;
  resolution: "fix-code" | "submit-model-proposal" | "inspect" | "none";
  author: string | null;
  objects: { id: string; exists: boolean; kind: string | null }[];
  locations: {
    path: string;
    startLine?: number;
    endLine?: number;
    check: "ok" | "missing" | "unsafe" | "line-out-of-range" | "not-checked";
    lines: number | null;
  }[];
  tests: {
    path: string;
    name: string;
    check: "ok" | "missing" | "ambiguous" | "unsafe" | "not-checked";
    mapped: boolean;
    result: "passed" | "failed" | "error" | "skipped" | "not-run" | "ambiguous" | null;
  }[];
  /**
   * verified: every reference was checked and holds; invalid: some do not hold; unsupported: a
   * contradiction without a source location; not-checked: some reference could not be checked.
   */
  references: "verified" | "invalid" | "unsupported" | "not-checked";
  problems: string[];
};

// ---- the report ----------------------------------------------------------------------------------

export type GateSeverity = "block" | "warn";
export type GateReason = {
  severity: GateSeverity;
  code: string;
  /** Which policy setting decided the severity (e.g. "required.failed"); "integrity" is fixed. */
  rule: string;
  /** checked / observed / not-checked as in M4.1; claim for agent observations. */
  basis: "checked" | "observed" | "not-checked" | "claim";
  message: string;
  criterionId?: Id;
  objectIds?: Id[];
  test?: { path: string; name: string };
  bindingId?: string;
  path?: string;
  observationId?: string;
};

export type GateDecision = "pass" | "warn" | "block";

export type GateReport = {
  format: "vcv-gate-1";
  decision: GateDecision;
  /** One line for a check summary. */
  headline: string;
  base: { commit: string; mergeBase: string; containedInCandidate: boolean; modelRevision: string | null };
  candidate: { commit: string; branch: string | null; dirty: boolean; modelRevision: string; identityDigest: string };
  change: {
    kind: "code-first" | "model-first" | "model-and-code" | "no-change";
    lineage: Reconciliation["model"]["lineage"];
    changedFiles: number;
    introducedRevisions: number;
  };
  policy: { source: string; digest: string; changedByCandidate: boolean; effective: GatePolicy };
  reasons: GateReason[];
  reasonsTotal: number;
  reasonsTruncated: boolean;
  counts: { block: number; warn: number };
  criteria: {
    items: {
      id: Id;
      verification: "required" | "optional";
      result: CriterionEvidence["result"];
      observedBy: CriterionEvidence["resultObservedBy"];
      verifies: Id[];
    }[];
    total: number;
    truncated: boolean;
    results: CriteriaReport["results"];
  };
  runs: RunSummary[];
  observations: VerifiedObservation[];
  observationsTruncated: boolean;
  /** Null when the candidate's model could not be loaded, so nothing was reconciled. */
  reconciliation: {
    summary: Reconciliation["summary"];
    integrity: { ok: boolean; authorization: string };
    findingsTotal: number;
  } | null;
  notes: string[];
  budget: { limit: number; bytes: number; shrunk: boolean };
  /** Always false: VCV checked history, pointers, fingerprints and test results, never what the code does. */
  implementationChecked: false;
  limits: string[];
};

const LIMITS = [
  "A passing gate says the history is approved, the claims and the model agree where VCV can check them, and every required criterion's mapped test cases passed in a run captured here. It does not say those tests check the right thing: a mapping is an agent's or a person's claim.",
  "Agent observations are interpretations. VCV checks that the objects, files, lines and test cases they cite exist; it never confirms or refutes what they say.",
  "Tests were run by the host's own runner, outside VCV. A run is host-observed only when this process captured its report; how far that report can be trusted is how far the job that produced it can be.",
];

export type GateJUnit = {
  report: Uint8Array;
  root: string;
  runner: { name: string; version?: string };
  invocation: string;
  /**
   * The candidate's identity digest as the HOST read it before the tests ran (`vcv tests
   * identity`, in a step no candidate code had run in). Required for a host-observed result: the
   * gate never makes one up. Without it the report is captured as a claim.
   */
  before?: string;
};
export type GateRequest = {
  /** The protected base, as a full commit ID supplied by the host. */
  base: string;
  /** Reports to capture here (host-observed for a caller holding tests:observe). */
  junit?: GateJUnit[];
  /** Imported test-run records: claims, whatever they declare. */
  runs?: unknown[];
  coverage?: { linesPct: number; source: string };
  /** Agent-authored observations (vcv-observations-1). */
  observations?: unknown;
  /** The policy, supplied by the host (vcv-policy-1). */
  policy?: unknown;
  /** Or: a repository path whose bytes are read at the base commit. */
  policyAtBase?: string;
};

const cut = (s: string, n: number = GATE_LIMITS.messageChars) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Decide whether the candidate containing `path` may merge into `base`. Read-only; runs nothing. */
export function preMergeGate(
  path: string,
  req: GateRequest,
  host: TestRunHost,
  hooks: ProposalHooks = {},
  options: GateOptions = {},
): ProposalResult<GateReport> {
  const budget = budgetOf(options);
  const bad = (message: string): ProposalResult<GateReport> => ({
    ok: false,
    error: { code: "INVALID_REQUEST", message },
  });
  if (typeof req?.base !== "string" || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(req.base))
    return bad("base must be the protected base's full commit ID, as the host supplies it");
  if (req.policy !== undefined && req.policyAtBase !== undefined)
    return bad("give either policy or policyAtBase, not both");
  if (req.policyAtBase !== undefined && (typeof req.policyAtBase !== "string" || pathProblem(req.policyAtBase)))
    return bad("policyAtBase must be a portable repository-relative path");
  if ((req.junit?.length ?? 0) + (req.runs?.length ?? 0) > 10) return bad("at most 10 test runs");

  let observations: z.infer<typeof observationsSchema> | null = null;
  if (req.observations !== undefined) {
    const o = observationsSchema.safeParse(req.observations);
    if (!o.success)
      return {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "observations do not match vcv-observations-1",
          details: o.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      };
    const ids = o.data.observations.map((x) => x.id);
    if (new Set(ids).size !== ids.length) return bad("observation IDs must be unique");
    observations = o.data;
  }

  // 1. The candidate's identity and every other input the decision reads (the whole .vcv/ store,
  //    attestations and trust list included, the candidate's copy of the policy file, every file an
  //    observation cites), before anything else reads them. Checked again after every phase and
  //    before answering: the parts of the answer describe one state.
  const cited = citedPaths(observations, req.policyAtBase);
  const first = snapshotNow(path, cited, hooks, budget);
  if (!first.ok) {
    // A candidate whose model cannot be loaded (hand-edited revision, conflict, no project) is a
    // decision, not a setup error: it blocks, with the reason.
    if (first.error.code === "PROJECT_NOT_READY") return notReady(path, req, first.error.message);
    return first;
  }
  const root = first.data.root;
  if (!resolveCommit(root, req.base))
    return {
      ok: false,
      error: {
        code: "UNKNOWN_COMMIT",
        message: `${req.base} is not a commit in this repository (fetch the base first)`,
      },
    };
  const moved = (phase: string): ProposalResult<GateReport> | null => {
    const now = snapshotNow(path, cited, hooks, budget);
    if (now.ok && now.data.key === first.data.key) return null;
    if (!now.ok && now.error.code === "SOURCE_IDENTITY_UNAVAILABLE") return now;
    return {
      ok: false,
      error: {
        code: "STATE_CHANGED",
        message: `the candidate changed while the gate was reading it (${phase}: source, claims, model, approvals or cited files); run the gate again`,
      },
    };
  };

  // 2. The policy: the host's file, or the base commit's bytes. Never the candidate's working tree.
  const pol = policyOf(root, req);
  if ("error" in pol) return { ok: false, error: pol.error };

  // 3. History, structure, bindings: M4.1, pinned to the base, attestation required. The policy is
  //    applied to every finding, before the report's lists are cut.
  let allFindings: ReconcileFinding[] | null = null;
  const rec = reconcile(
    path,
    { base: req.base, trust: { kind: "git-ref", ref: req.base, pinnedCommit: req.base }, requireAttestation: true },
    hooks,
    (all) => (allFindings = all),
  );
  if (!rec.ok) return { ok: false, ...(rec.context ? { context: rec.context } : {}), error: rec.error };
  if (!allFindings)
    return { ok: false, error: { code: "STORE_ERROR", message: "the reconciliation produced no findings list" } };
  const afterReconcile = moved("after the history and claims were checked");
  if (afterReconcile) return afterReconcile;
  const baseContext = baseClaimContext(root, rec.data);

  // 4. Runs. A report is admitted as host-observed only with the identity the HOST read before the
  //    tests ran (`before`), and only if the candidate still has exactly that identity: an old
  //    report cannot be rebound to new source. A report without it is captured as a claim.
  const captured: TestRunRecord[] = [];
  const claimHost: TestRunHost = { principalId: host.principalId, permissions: [] };
  for (const [i, j] of (req.junit ?? []).entries()) {
    const bound = typeof j.before === "string";
    const c = captureTestRun(
      path,
      j.report,
      { root: j.root, runner: j.runner, invocation: j.invocation, ...(bound ? { before: j.before } : {}) },
      bound ? host : claimHost,
      hooks,
    );
    if (!c.ok)
      return {
        ok: false,
        ...(c.context ? { context: c.context } : {}),
        error: { ...c.error, message: `report ${i}: ${c.error.message}` },
      };
    captured.push(c.data);
  }
  const runs: unknown[] = [...captured, ...(req.runs ?? [])];

  // 5. Criteria and their results; batched by ID if the full report had to be cut.
  const crit = criteriaAll(path, runs, req.coverage, hooks);
  if (!crit.ok) return crit;
  const afterCriteria = moved("after the criteria and test results were read");
  if (afterCriteria) return afterCriteria;

  // 6. Agent observations, checked against this candidate; then every input again.
  return observed(path, hooks, (obs) => {
    const index = buildIndex(obs.model);
    const verified = (observations?.observations ?? []).map((o) =>
      verifyObservation(o, obs.status.root, index, crit.data, runs as TestRunRecord[]),
    );
    const pending = obs.records.flatMap((r) => (r.record?.status === "pending" ? [r.changeId] : [])).sort();
    const report = decide(rec.data, allFindings!, crit.data, verified, pol, first.data.identity, baseContext, pending);
    const bounded = fitBudget(redact(report, root));
    if (!bounded)
      return {
        ok: false,
        error: {
          code: "REPORT_TOO_LARGE",
          message: `the gate report exceeds ${GATE_LIMITS.bytes} bytes even with every list cut`,
        },
      } as ProposalResult<GateReport>;
    return finish(obs, hooks, bounded, {
      key: first.data.key,
      again: () => snapshotKey(obs, cited, budget) ?? "incomplete",
    });
  });
}

/** Repository paths whose bytes the decision depends on beyond the candidate identity. */
function citedPaths(
  observations: z.infer<typeof observationsSchema> | null,
  policyAtBase: string | undefined,
): string[] {
  const out = new Set<string>();
  for (const o of observations?.observations ?? []) {
    for (const l of o.locations) if (!pathProblem(l.path)) out.add(l.path);
    for (const t of o.tests) if (!pathProblem(t.path)) out.add(t.path);
  }
  if (policyAtBase) out.add(policyAtBase);
  return [...out].sort();
}

function snapshotNow(
  path: string,
  cited: string[],
  hooks: ProposalHooks,
  budget: StoreBudget,
): ProposalResult<{ key: string; identity: string; root: string }> {
  return observed(path, hooks, (obs) => {
    const key = snapshotKey(obs, cited, budget);
    if (key === null) {
      return {
        ok: false,
        error: {
          code: "SOURCE_IDENTITY_UNAVAILABLE",
          message: `the .vcv/ store cannot be observed completely (an unreadable entry, or more than ${budget.entries} entries, ${budget.depth} levels or ${budget.bytes} bytes); the decision depends on all of it, so the gate does not decide`,
        },
      };
    }
    return finish(
      obs,
      hooks,
      { key, identity: identityDigest(candidateIdentityOf(obs).candidate), root: obs.status.root },
      { key, again: () => snapshotKey(obs, cited, budget) ?? "incomplete" },
    );
  });
}

/**
 * The candidate identity (commit, uncommitted and bound bytes, model revision, claims), plus the
 * bytes of every file in the .vcv/ store (revisions, change records, attestations, the trust list:
 * the integrity check's inputs) and of every cited path, ignored files included.
 */
function snapshotKey(obs: Observation, cited: string[], budget: StoreBudget): string | null {
  const store = storeDigest(obs.status.storeDir, budget);
  if (store === null) return null;
  return canonicalJson([
    identityDigest(candidateIdentityOf(obs).candidate),
    store,
    worktreeState(obs.status.root, cited).digest,
  ]);
}

/**
 * sha256 over every entry under the store directory: path, type, and bytes (or link text). Null
 * when the store cannot be observed completely (an unreadable entry, too many entries, too deep,
 * too many bytes): the decision depends on every attestation and trust-list byte, so a partial
 * walk would let an unobserved change through (M4.4 review round 2).
 */
function storeDigest(dir: string, budget: StoreBudget): string | null {
  const h = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  const walk = (abs: string, rel: string, depth: number): boolean => {
    if (depth > budget.depth) return false;
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return false;
    }
    for (const n of names) {
      const a = join(abs, n);
      const r = rel ? `${rel}/${n}` : n;
      if (++entries > budget.entries) return false;
      let st;
      try {
        st = lstatSync(a);
      } catch {
        return false;
      }
      if (st.isDirectory()) {
        h.update(`dir\0${r}\0`);
        if (!walk(a, r, depth + 1)) return false;
      } else if (st.isSymbolicLink()) {
        const target = safeReadlink(a);
        if (target === null) return false;
        h.update(`link\0${r}\0${target}\0`);
      } else if (st.isFile()) {
        bytes += st.size;
        if (bytes > budget.bytes) return false;
        const sha = fileSha(a, st.size);
        if (sha === null) return false;
        h.update(`file\0${r}\0${st.size}\0${sha}\0`);
      } else h.update(`other\0${r}\0`);
    }
    return true;
  };
  return walk(dir, "", 0) ? h.digest("hex") : null;
}
const safeReadlink = (a: string): string | null => {
  try {
    return readlinkSync(a);
  } catch {
    return null;
  }
};
const fileSha = (a: string, max: number): string | null => {
  const b = boundedRead(a, max);
  return b ? createHash("sha256").update(b).digest("hex") : null;
};

type BaseContext = { objects: Set<Id>; complete: boolean; problem: string | null };

/**
 * What the protected base's claims say the change touches (M4.4 review): objects whose base-side
 * claims point into a changed file, or whose claims the candidate removed or reasserted. Removing a
 * claim must not take its object out of the policy's scope.
 */
function baseClaimContext(root: string, rec: Reconciliation): BaseContext {
  const objects = new Set<Id>();
  const changed = new Set(rec.source.files.map((f) => f.path));
  const mb = rec.base.mergeBase;
  const dir = ".vcv/bindings";
  let complete = !rec.source.truncated;
  let problem: string | null = rec.source.truncated ? "the changed-file list was cut" : null;
  const files = filesAtCommit(root, mb, dir);
  const touchedIds = new Set(
    rec.bindings.items.filter((b) => b.atBase === "removed" || b.atBase === "reasserted").map((b) => b.bindingId),
  );
  if (rec.bindings.truncated) {
    complete = false;
    problem = "the claim list was cut";
  }
  for (const rel of files) {
    if (!rel.startsWith(`${dir}/`) || !rel.endsWith(".json") || rel.slice(dir.length + 1).includes("/")) continue;
    const id = rel.slice(dir.length + 1, -".json".length);
    const bytes = fileAtCommit(root, mb, rel, MAX_CLAIM_BYTES);
    let claim: { modelObjectId?: unknown; locator?: { path?: unknown } } | null = null;
    try {
      claim = bytes ? JSON.parse(bytes.toString("utf8")) : null;
    } catch {
      claim = null;
    }
    if (!claim || typeof claim.modelObjectId !== "string" || typeof claim.locator?.path !== "string") {
      complete = false;
      problem = `claim ${id} at the merge base cannot be read`;
      continue;
    }
    if (changed.has(claim.locator.path) || touchedIds.has(id)) objects.add(claim.modelObjectId);
  }
  return { objects, complete, problem };
}

function notReady(path: string, req: GateRequest, message: string): ProposalResult<GateReport> {
  const root = findWorkTreeRoot(path);
  const commit = root ? headCommit(root) : null;
  if (!root || !commit) return { ok: false, error: { code: "PROJECT_NOT_READY", message } };
  if (!resolveCommit(root, req.base))
    return {
      ok: false,
      error: {
        code: "UNKNOWN_COMMIT",
        message: `${req.base} is not a commit in this repository (fetch the base first)`,
      },
    };
  const pol = policyOf(root, req);
  if ("error" in pol) return { ok: false, error: pol.error };
  const mb = mergeBase(root, req.base, commit);
  const reason: GateReason = {
    severity: "block",
    code: "PROJECT_NOT_READY",
    rule: "integrity",
    basis: "checked",
    message: cut(message),
  };
  const empty = { passed: 0, failed: 0, stale: 0, missing: 0, unknown: 0, unverified: 0 };
  const report: GateReport = {
    format: "vcv-gate-1",
    decision: "block",
    headline: "blocked: the candidate's model cannot be loaded (PROJECT_NOT_READY)",
    base: { commit: req.base, mergeBase: mb ?? req.base, containedInCandidate: mb === req.base, modelRevision: null },
    candidate: {
      commit,
      branch: currentBranchRef(root),
      dirty: false,
      modelRevision: "unknown",
      identityDigest: "unknown",
    },
    change: { kind: "no-change", lineage: "rewritten", changedFiles: 0, introducedRevisions: 0 },
    policy: {
      source: pol.source,
      digest: pol.digest,
      changedByCandidate: pol.changedByCandidate,
      effective: pol.policy,
    },
    reasons: [reason],
    reasonsTotal: 1,
    reasonsTruncated: false,
    counts: { block: 1, warn: 0 },
    criteria: { items: [], total: 0, truncated: false, results: { required: { ...empty }, optional: { ...empty } } },
    runs: [],
    observations: [],
    observationsTruncated: false,
    reconciliation: null,
    notes: ["Nothing else was assessed: the candidate's model, claims and runs are only read from a loadable project."],
    budget: { limit: GATE_LIMITS.bytes, bytes: 0, shrunk: false },
    implementationChecked: false,
    limits: LIMITS,
  };
  const context = {
    projectId: "unknown",
    modelRevision: "unknown",
    snapshotStatus: "not-ready",
    source: "model-proposals" as const,
    implementationChecked: false as const,
    observed: { commit, branch: currentBranchRef(root), dirty: null },
  };
  return { ok: true, context, data: fitBudget(redact(report, root))! };
}

type ResolvedPolicy = { policy: GatePolicy; source: string; digest: string; changedByCandidate: boolean };

function policyOf(root: string, req: GateRequest): ResolvedPolicy | { error: ProposalError } {
  const parse = (value: unknown, source: string): ResolvedPolicy | { error: ProposalError } => {
    const p = gatePolicySchema.safeParse(value);
    if (!p.success)
      return {
        error: {
          code: "POLICY_INVALID",
          message: `the policy from ${source} does not match vcv-policy-1`,
          details: p.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      };
    return { policy: p.data, source, digest: sha256(canonicalJson(p.data)), changedByCandidate: false };
  };
  if (req.policy !== undefined) return parse(req.policy, "the host");
  if (req.policyAtBase === undefined)
    return {
      policy: DEFAULT_POLICY,
      source: "default",
      digest: sha256(canonicalJson(DEFAULT_POLICY)),
      changedByCandidate: false,
    };
  const rel = req.policyAtBase;
  // Only real absence means "no policy": an oversized, non-file or unreadable entry is an error,
  // never a silent fallback to the defaults.
  const entry = entryAtCommit(root, req.base, rel);
  if (entry === null)
    return { error: { code: "POLICY_INVALID", message: `${rel} at the base cannot be read from Git` } };
  if (entry.kind === "other")
    return {
      error: { code: "POLICY_INVALID", message: `${rel} at the base is not a regular file (mode ${entry.mode})` },
    };
  if (entry.kind === "blob" && entry.size > GATE_LIMITS.policyBytes)
    return {
      error: {
        code: "POLICY_INVALID",
        message: `${rel} at the base is ${entry.size} bytes, more than the ${GATE_LIMITS.policyBytes} read`,
      },
    };
  const atBase = entry.kind === "blob" ? fileAtCommit(root, req.base, rel, GATE_LIMITS.policyBytes) : null;
  if (entry.kind === "blob" && atBase === null)
    return { error: { code: "POLICY_INVALID", message: `${rel} at the base cannot be read from Git` } };
  const now = readCandidate(root, rel);
  const changed = now === "unreadable" || (atBase === null ? now !== null : now === null || !atBase.equals(now));
  if (atBase === null) {
    return {
      policy: DEFAULT_POLICY,
      source: `default (no ${rel} at the base)`,
      digest: sha256(canonicalJson(DEFAULT_POLICY)),
      changedByCandidate: changed,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(atBase));
  } catch {
    return { error: { code: "POLICY_INVALID", message: `${rel} at the base is not UTF-8 JSON` } };
  }
  const r = parse(json, `${rel} at the base (${req.base.slice(0, 12)})`);
  return "error" in r ? r : { ...r, changedByCandidate: changed };
}

function readCandidate(root: string, rel: string): Buffer | null | "unreadable" {
  const where = resolveInside(root, rel);
  if (!where.ok) return where.reason === "missing" && !where.unreadable ? null : "unreadable";
  return boundedRead(where.abs, GATE_LIMITS.policyBytes) ?? "unreadable";
}

/** A regular file of at most `max` bytes, opened nonblocking and without following a final link; null otherwise. */
function boundedRead(abs: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r; n <= max && (r = readSync(fd, buf, n, max + 1 - n, null)) > 0; ) n += r;
    return n > max ? null : buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function criteriaAll(
  path: string,
  runs: unknown[],
  coverage: GateRequest["coverage"],
  hooks: ProposalHooks,
): ProposalResult<CriteriaReport> {
  const input = { ...(runs.length ? { runs } : {}), ...(coverage ? { coverage } : {}) };
  const all = criteriaEvidence(path, input, hooks);
  if (!all.ok || !all.data.truncated) return all;
  // Cut to fit: evaluate every criterion in batches, so the decision sees all of them.
  const listed = new Set(all.data.criteria.map((c) => c.id));
  const ids = allCriterionIds(path, hooks);
  if (!ids.ok) return ids;
  const rest = ids.data.filter((id) => !listed.has(id));
  const more: CriterionEvidence[] = [];
  for (let i = 0; i < rest.length; i += GATE_LIMITS.criteriaBatch) {
    const part = criteriaEvidence(path, { ...input, ids: rest.slice(i, i + GATE_LIMITS.criteriaBatch) }, hooks);
    if (!part.ok) return part;
    if (part.data.truncated)
      return {
        ok: false,
        error: { code: "REPORT_TOO_LARGE", message: "a batch of criteria does not fit the criteria report" },
      };
    more.push(...part.data.criteria);
  }
  const criteria = [...all.data.criteria, ...more].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...all, data: { ...all.data, criteria, truncated: criteria.length < all.data.total } };
}

function allCriterionIds(path: string, hooks: ProposalHooks): ProposalResult<Id[]> {
  return observed(path, hooks, (obs) => finish(obs, hooks, (obs.model.criteria ?? []).map((c) => c.id).sort()));
}

function verifyObservation(
  o: z.infer<typeof observationsSchema>["observations"][number],
  root: string,
  index: ReturnType<typeof buildIndex>,
  crit: CriteriaReport,
  runs: TestRunRecord[],
): VerifiedObservation {
  const problems: string[] = [];
  /** References VCV could not check: never called verified. */
  const unchecked: string[] = [];
  const objects = [...new Set(o.objects)].map((id) => {
    const hit = index.byId.get(id);
    if (!hit) problems.push(`${id} is not an object of the candidate's model`);
    return { id, exists: !!hit, kind: hit?.kind ?? null };
  });
  const locations = o.locations.map((l) => {
    const out: VerifiedObservation["locations"][number] = {
      path: l.path,
      ...(l.startLine ? { startLine: l.startLine } : {}),
      ...(l.endLine ? { endLine: l.endLine } : {}),
      check: "ok",
      lines: null,
    };
    if (pathProblem(l.path)) {
      problems.push(`${cut(l.path, 200)} is not a portable repository path`);
      return { ...out, check: "unsafe" as const };
    }
    const where = resolveInside(root, l.path);
    if (!where.ok) {
      problems.push(`${cut(l.path, 200)}: ${where.message}`);
      return { ...out, check: where.reason === "unsafe" ? ("unsafe" as const) : ("missing" as const) };
    }
    if (l.startLine === undefined && l.endLine === undefined) return out;
    try {
      const bytes = boundedRead(where.abs, GATE_LIMITS.lineCheckBytes);
      if (!bytes) return { ...out, check: "not-checked" as const };
      const text = bytes.toString("utf8");
      const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      const last = Math.max(l.startLine ?? 0, l.endLine ?? 0);
      const inRange =
        last <= lines && (l.startLine === undefined || l.endLine === undefined || l.startLine <= l.endLine);
      if (!inRange) problems.push(`${cut(l.path, 200)} has ${lines} lines; the cited range is not in it`);
      return { ...out, lines, check: inRange ? ("ok" as const) : ("line-out-of-range" as const) };
    } catch {
      return { ...out, check: "not-checked" as const };
    }
  });
  const mapped = new Set(crit.tests.map((t) => `${t.test.path}\0${t.test.name}`));
  const fresh = new Set(crit.runs.filter((r) => r.fresh).map((r) => r.index));
  const tests = o.tests.map((t) => {
    // The cited test case must exist in the candidate, whether or not any run is available.
    const res = pathProblem(t.path)
      ? null
      : resolveLocator(root, { path: t.path, selector: { kind: "test", name: t.name } });
    const check: VerifiedObservation["tests"][number]["check"] = !res
      ? "unsafe"
      : res.state === "resolved"
        ? "ok"
        : res.state === "ambiguous"
          ? "ambiguous"
          : res.state === "missing"
            ? "missing"
            : "not-checked";
    if (check === "unsafe") problems.push(`${cut(t.path, 200)} is not a portable repository path`);
    else if (check === "missing" || check === "ambiguous")
      problems.push(`test case "${cut(t.name, 200)}" in ${cut(t.path, 200)}: ${cut(res!.detail, 300)}`);
    else if (check === "not-checked")
      unchecked.push(`test case "${cut(t.name, 200)}" in ${cut(t.path, 200)}: ${cut(res!.detail, 300)}`);
    const k = caseKey(t.path, t.name);
    const statuses = runs.flatMap((r, i) =>
      fresh.has(i) ? r.cases.filter((c) => c.key === k).map((c) => c.status) : [],
    );
    const anyFresh = fresh.size > 0;
    const result =
      statuses.length > 1
        ? ("ambiguous" as const)
        : statuses.length === 1
          ? statuses[0]!
          : anyFresh
            ? ("not-run" as const)
            : null;
    if (anyFresh && !statuses.length)
      problems.push(`test case "${cut(t.name, 200)}" in ${cut(t.path, 200)} is in no fresh run`);
    return { path: t.path, name: cut(t.name, 300), check, mapped: mapped.has(`${t.path}\0${t.name}`), result };
  });
  for (const l of locations)
    if (l.check === "not-checked")
      unchecked.push(
        `${cut(l.path, 200)}: the cited lines could not be checked (unreadable or larger than ${GATE_LIMITS.lineCheckBytes} bytes)`,
      );
  const invalid = problems.length > 0;
  const unsupported = o.kind === "contradiction" && o.locations.length === 0;
  if (unsupported) problems.push("a contradiction must cite at least one source location");
  return {
    id: o.id,
    kind: o.kind,
    basis: "claim",
    statement: o.statement,
    resolution: o.resolution,
    author: o.author ?? null,
    objects,
    locations,
    tests,
    references: invalid ? "invalid" : unsupported ? "unsupported" : unchecked.length ? "not-checked" : "verified",
    problems: [...problems, ...unchecked].slice(0, 20).map((p) => cut(p, 500)),
  };
}

// ---- the decision -------------------------------------------------------------------------------

const BINDING_CODES = new Set([
  "CLAIM_STALE",
  "LOCATOR_MISSING",
  "LOCATOR_AMBIGUOUS",
  "CLAIM_INVALID",
  "CLAIM_REMOVED",
  "CLAIM_DISPUTED",
]);

function decide(
  rec: Reconciliation,
  findings: ReconcileFinding[],
  crit: CriteriaReport,
  observations: VerifiedObservation[],
  pol: ResolvedPolicy,
  digest: string,
  baseContext: BaseContext,
  pending: string[] = [],
): GateReport {
  const p = pol.policy;
  const reasons: GateReason[] = [];
  const add = (severity: GateSeverity | "off", r: Omit<GateReason, "severity">) => {
    if (severity !== "off") reasons.push({ severity, ...r, message: cut(r.message) });
  };

  // Integrity: fixed. Invalid or unattested history never merges.
  for (const e of rec.model.integrity.errors)
    add("block", { code: e.code, rule: "integrity", basis: "checked", message: e.message });
  if (!rec.model.integrity.ok && rec.model.integrity.errors.length === 0) {
    add("block", {
      code: "INTEGRITY_FAILED",
      rule: "integrity",
      basis: "checked",
      message: "the model history is not consistent and attested under the base's trust list",
    });
  } else if (rec.model.integrity.errorsTotal > rec.model.integrity.errors.length) {
    add("block", {
      code: "INTEGRITY_FAILED",
      rule: "integrity",
      basis: "checked",
      message: `${rec.model.integrity.errorsTotal - rec.model.integrity.errors.length} more integrity errors (list cut)`,
    });
  }

  // Reconciliation findings: every one of them, before the report's lists are cut, so adding
  // lower-severity findings can never push a blocking one out of view.
  for (const f of findings) {
    const base = findingReason(f);
    if (f.category === "structural") add(p.structural, { ...base, rule: "structural" });
    else if (f.category === "binding" && BINDING_CODES.has(f.code))
      add(f.related ? p.bindings.related : p.bindings.unrelated, {
        ...base,
        rule: f.related ? "bindings.related" : "bindings.unrelated",
      });
    else if (f.category === "coverage") add(p.coverage, { ...base, rule: "coverage" });
    else if (f.category === "unsupported") add(p.unsupported, { ...base, rule: "unsupported" });
    else if (f.code === "BASE_NOT_CONTAINED") add(p.baseNotContained, { ...base, rule: "baseNotContained" });
  }
  if (!rec.bindings.available) {
    add("block", {
      code: "BINDINGS_UNAVAILABLE",
      rule: "integrity",
      basis: "not-checked",
      message: `the claim store cannot be read${rec.bindings.problem ? `: ${rec.bindings.problem}` : ""}; no claim or mapping can be assessed`,
    });
  }

  // Criteria.
  const criteria = crit.criteria;
  if (crit.counts.criteria === 0)
    add(p.noCriteria, {
      code: "NO_CRITERIA",
      rule: "noCriteria",
      basis: "observed",
      message: "the approved model has no acceptance criteria, so test evidence gates nothing",
    });
  if (crit.truncated)
    add("block", {
      code: "CRITERIA_NOT_ALL_ASSESSED",
      rule: "integrity",
      basis: "not-checked",
      message: `${crit.total - criteria.length} criteria could not be assessed within the report limits`,
    });
  for (const c of criteria) {
    const set = c.verification === "required" ? REQUIRED_EVIDENCE : p.optional;
    const prefix = c.verification;
    if (c.result === "passed") {
      if (c.resultObservedBy !== "host")
        add(set.claimed, {
          code: "RESULT_CLAIMED",
          rule: `${prefix}.claimed`,
          basis: "claim",
          criterionId: c.id,
          objectIds: c.verifies,
          message: `${c.id} (${prefix}) passed only in runs that were not captured here: a claim, not host-observed evidence`,
        });
      continue;
    }
    const tests = c.problems.filter(
      (x) =>
        x.code === "TEST_FAILED" ||
        x.code === "TEST_ERRORED" ||
        x.code === "TEST_SKIPPED" ||
        x.code === "TEST_NOT_RUN" ||
        x.code === "RESULT_AMBIGUOUS" ||
        x.code === "RESULT_STALE",
    );
    const failing = c.mappings.filter((m) => m.result && m.result.status !== "passed" && m.test);
    const head = `${c.id} (${prefix}) is ${c.result}`;
    const detail = tests.length
      ? tests.map((t) => t.message).join("; ")
      : c.problems.map((x) => x.message).join("; ") || "no runs were supplied";
    if (failing.length) {
      for (const m of failing) {
        add(set[c.result], {
          code: codeFor(c.result, m.result!.status),
          rule: `${prefix}.${c.result}`,
          basis: "checked",
          criterionId: c.id,
          objectIds: c.verifies,
          test: { path: m.test!.path, name: m.test!.name },
          bindingId: m.bindingId,
          message: `${head}: "${m.test!.name}" in ${m.test!.path} ${m.result!.status}${m.result!.message ? `: ${m.result!.message}` : ""}`,
        });
      }
    } else {
      add(set[c.result], {
        code: codeFor(c.result, null),
        rule: `${prefix}.${c.result}`,
        basis: c.result === "unknown" ? "not-checked" : "checked",
        criterionId: c.id,
        objectIds: c.verifies,
        message: `${head}: ${detail}`,
      });
    }
  }

  // Mappings the candidate touched: routine upkeep, no approval needed, so a reviewer should look.
  const criterionIds = new Set(criteria.map((c) => c.id));
  for (const b of rec.bindings.items) {
    if (b.relation !== "tests" || !b.modelObjectId || !criterionIds.has(b.modelObjectId)) continue;
    if (b.atBase === "unchanged" && !b.boundFileChanged) continue;
    const what =
      b.atBase === "removed"
        ? "was removed"
        : b.atBase === "added"
          ? "was added"
          : b.atBase === "reasserted"
            ? "was reasserted"
            : "is unchanged, but its test file changed";
    add(p.mappingChanged, {
      code: "MAPPING_CHANGED",
      rule: "mappingChanged",
      basis: "observed",
      criterionId: b.modelObjectId,
      objectIds: [b.modelObjectId],
      bindingId: b.bindingId,
      message: `the mapping ${b.bindingId} of ${b.modelObjectId} (${b.locator ?? "?"}) ${what} in this candidate; mappings change without approval, so check the test still checks the criterion`,
    });
  }
  if (rec.bindings.truncated && p.mappingChanged !== "off") {
    add(p.mappingChanged, {
      code: "MAPPING_CHANGED",
      rule: "mappingChanged",
      basis: "not-checked",
      message: `the claim list was cut at ${rec.bindings.items.length} of ${rec.bindings.total}; mappings beyond it may have changed`,
    });
  }

  // Objects the policy says need evidence whenever a change touches them.
  const touched = touchedObjects(rec, baseContext);
  for (const r of p.requireEvidence) {
    if (!touched.all && !touched.ids.has(r.object)) continue;
    // Every criterion is assessed here (a cut criteria list blocks above), so this sees all of them.
    const verifying = criteria.filter((c) => c.verification === "required" && c.verifies.includes(r.object));
    const ok = verifying.some((c) => c.result === "passed" && c.resultObservedBy === "host");
    if (!ok) {
      add("block", {
        code: "EVIDENCE_REQUIRED",
        rule: "requireEvidence",
        basis: "checked",
        objectIds: [r.object],
        message: `${r.object} is touched by this change${touched.all ? " (or may be: the impact list was cut)" : ""} and the policy requires a host-observed pass of a required criterion that verifies it${verifying.length ? ` (${verifying.map((c) => c.id).join(", ")} did not pass)` : "; none verifies it"}${r.reason ? `. ${r.reason}` : ""}`,
      });
    }
  }

  // Agent observations: claims, checked for what they cite.
  for (const o of observations) {
    if (o.references !== "verified") {
      add(p.observations.invalidReferences, {
        code:
          o.references === "unsupported"
            ? "OBSERVATION_WITHOUT_LOCATION"
            : o.references === "not-checked"
              ? "OBSERVATION_REFERENCES_NOT_CHECKED"
              : "OBSERVATION_REFERENCES_INVALID",
        rule: "observations.invalidReferences",
        basis: "claim",
        observationId: o.id,
        message: `${o.id}: ${o.problems.join("; ")}`,
      });
    }
    if (o.kind === "note") continue;
    add(p.observations[o.kind], {
      code: o.kind === "contradiction" ? "AGENT_CONTRADICTION" : "AGENT_CONCERN",
      rule: `observations.${o.kind}`,
      basis: "claim",
      observationId: o.id,
      ...(o.objects.length ? { objectIds: o.objects.map((x) => x.id) } : {}),
      ...(o.locations[0] ? { path: o.locations[0].path } : {}),
      message: `${o.id} (agent claim, not checked by VCV; proposes ${o.resolution}): ${cut(o.statement, 600)}`,
    });
  }

  // A proposal the candidate carries but nobody has approved: the approved model (and so this
  // check) does not include it. Shown so the reviewer knows an intent change is waiting on M3.
  for (const id of pending.slice(0, GATE_LIMITS.reasons)) {
    add("warn", {
      code: "PROPOSAL_PENDING",
      rule: "integrity",
      basis: "observed",
      message: `the candidate carries the pending proposal ${id}; it is not part of the approved model this check used. If the code depends on it, a separate reviewer approves it through M3 (vcv review approve)`,
    });
  }
  if (pol.changedByCandidate)
    add(p.policyChanged, {
      code: "POLICY_CHANGED",
      rule: "policyChanged",
      basis: "observed",
      message: `the candidate changes the gate policy (${pol.source}); this check used the base's, and the change applies only after the merge`,
    });

  const order = { block: 0, warn: 1 };
  reasons.sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = {
    block: reasons.filter((r) => r.severity === "block").length,
    warn: reasons.filter((r) => r.severity === "warn").length,
  };
  const decision: GateDecision = counts.block ? "block" : counts.warn ? "warn" : "pass";
  const required = crit.results.required;
  const reqTotal = Object.values(required).reduce((a, b) => a + b, 0);
  const headline =
    decision === "block"
      ? `blocked: ${counts.block} blocking reason${counts.block === 1 ? "" : "s"} (${reasons
          .filter((r) => r.severity === "block")
          .slice(0, 3)
          .map((r) => r.criterionId ?? r.code)
          .join(", ")}${counts.block > 3 ? ", …" : ""})`
      : `${decision === "pass" ? "passed" : `passed with ${counts.warn} warning${counts.warn === 1 ? "" : "s"}`}: ${required.passed}/${reqTotal} required criteria passed, host-observed`;
  const kind =
    rec.model.introducedTotal > 0
      ? rec.summary.changedFiles > countModelFiles(rec)
        ? "model-and-code"
        : "model-first"
      : rec.summary.changedFiles > 0
        ? "code-first"
        : "no-change";
  return {
    format: "vcv-gate-1",
    decision,
    headline,
    base: {
      commit: rec.base.commit,
      mergeBase: rec.base.mergeBase,
      containedInCandidate: rec.base.containedInCandidate,
      modelRevision: rec.base.modelRevision,
    },
    candidate: {
      commit: rec.candidate.commit,
      branch: rec.candidate.branch,
      dirty: rec.candidate.dirty,
      modelRevision: rec.candidate.modelRevision,
      identityDigest: digest,
    },
    change: {
      kind,
      lineage: rec.model.lineage,
      changedFiles: rec.summary.changedFiles,
      introducedRevisions: rec.model.introducedTotal,
    },
    policy: { source: pol.source, digest: pol.digest, changedByCandidate: pol.changedByCandidate, effective: p },
    reasons: reasons.slice(0, GATE_LIMITS.reasons),
    reasonsTotal: reasons.length,
    reasonsTruncated: reasons.length > GATE_LIMITS.reasons,
    counts,
    criteria: {
      items: criteria
        .slice(0, GATE_LIMITS.criteria)
        .map((c) => ({
          id: c.id,
          verification: c.verification,
          result: c.result,
          observedBy: c.resultObservedBy,
          verifies: c.verifies,
        })),
      total: crit.total,
      truncated: criteria.length > GATE_LIMITS.criteria || crit.truncated,
      results: crit.results,
    },
    runs: crit.runs,
    observations,
    observationsTruncated: false,
    reconciliation: {
      summary: rec.summary,
      integrity: { ok: rec.model.integrity.ok, authorization: rec.model.integrity.authorization },
      findingsTotal: rec.findingsTotal,
    },
    notes: crit.notes.map((n) => `${n.code}: ${n.message}`),
    budget: { limit: GATE_LIMITS.bytes, bytes: 0, shrunk: false },
    implementationChecked: false,
    limits: LIMITS,
  };
}

function findingReason(f: ReconcileFinding): Omit<GateReason, "severity" | "rule"> {
  return {
    code: f.code,
    basis: f.basis,
    message: f.message,
    ...(f.objectIds?.length ? { objectIds: f.objectIds } : {}),
    ...(f.bindingId ? { bindingId: f.bindingId } : {}),
    ...(f.path ? { path: f.path } : {}),
  };
}

function codeFor(result: CriterionEvidence["result"], status: string | null): string {
  if (status === "failed") return "TEST_FAILED";
  if (status === "error") return "TEST_ERRORED";
  if (status === "skipped") return "TEST_SKIPPED";
  if (status === "not-run") return "TEST_NOT_RUN";
  if (status === "ambiguous") return "RESULT_AMBIGUOUS";
  if (status === "stale") return "RESULT_STALE";
  return {
    failed: "CRITERION_FAILED",
    stale: "CRITERION_STALE",
    missing: "CRITERION_MISSING",
    unknown: "CRITERION_UNKNOWN",
    unverified: "CRITERION_UNVERIFIED",
    passed: "CRITERION_PASSED",
  }[result];
}

/** Objects the change touches: the model delta and its impact, and the source impact's declared context. */
function touchedObjects(rec: Reconciliation, baseContext: BaseContext): { ids: Set<Id>; all: boolean } {
  // The base side too: an object whose base claims pointed into changed code, or whose claims were
  // removed or reasserted, stays in scope after its claims are gone.
  const ids = new Set<Id>(baseContext.objects);
  for (const c of rec.model.delta.changes) ids.add(c.id);
  const imp = rec.model.impact;
  if (imp) {
    for (const m of imp.modules) ids.add(m.id);
    for (const c of imp.contracts) ids.add(c.id);
    for (const c of imp.candidates) ids.add(c.id);
  }
  const s = rec.sourceImpact;
  if (s) {
    for (const x of [
      ...s.seeds.map((v) => v.objectId),
      ...s.modules.map((v) => v.id),
      ...s.contracts.map((v) => v.id),
      ...s.rules.map((v) => v.id),
      ...s.candidates.map((v) => v.id),
    ])
      ids.add(x);
  }
  // A cut list may hide a touched object: then every required-evidence object counts as touched.
  const all =
    !baseContext.complete ||
    rec.model.delta.truncated ||
    !!imp?.truncated ||
    !!s?.truncated ||
    (s?.seedsTotal !== undefined && s.seedsTotal > s.seeds.length) ||
    (!rec.bindings.available && rec.summary.changedFiles > 0);
  return { ids, all };
}

function countModelFiles(rec: Reconciliation): number {
  return rec.source.files.filter((f) => f.area.startsWith("vcv-")).length;
}

function fitBudget(r: GateReport): GateReport | null {
  const size = (x: GateReport) => Buffer.byteLength(JSON.stringify(x, null, 2));
  let n = size(r);
  while (n > GATE_LIMITS.bytes) {
    const lists = [
      { len: r.reasons.length, cut: (k: number) => ((r.reasons = r.reasons.slice(0, k)), (r.reasonsTruncated = true)) },
      {
        len: r.criteria.items.length,
        cut: (k: number) => ((r.criteria.items = r.criteria.items.slice(0, k)), (r.criteria.truncated = true)),
      },
      {
        len: r.observations.length,
        cut: (k: number) => ((r.observations = r.observations.slice(0, k)), (r.observationsTruncated = true)),
      },
    ].sort((a, b) => b.len - a.len);
    if (lists[0]!.len <= 1) return null;
    lists[0]!.cut(Math.floor(lists[0]!.len / 2));
    r.budget.shrunk = true;
    n = size(r);
  }
  r.budget.bytes = n;
  return r;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
