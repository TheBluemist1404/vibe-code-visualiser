// Test runs as evidence (Issue #22, M4.3): a runner's per-case report, bound to what was tested.
//
// VCV runs no tests. The host (CI, or a person at a shell) runs the project's ordinary runner with
// a machine-readable reporter and hands VCV the report. `captureTestRun` reads it strictly
// (junit.ts) and binds it to the candidate it describes:
//
//   candidate   the Git commit, the identity of every uncommitted path (bytes, not mtimes), the model
//               revision and the set of binding claims, as one `identityDigest`;
//   provenance  host-observed only when the caller holds `tests:observe` (the host itself ran the
//               runner and read its output); otherwise agent-claimed. A record is data: it says who
//               captured it, not that the claim is true. A required gate (M4.4) accepts host runs
//               only, captured in its own trusted job;
//   invocation  the runner, its version if known, and the command, as the caller states them.
//
// A result is evidence for a criterion only while the candidate still has that identity: a run
// from commit A says nothing about commit B, and an edit after the run makes it stale. To close the
// gap between running and capturing, the host reads `testIdentity` first and passes its digest as
// `before`; if anything moved in between, capture is refused (TEST_RUN_RACED).
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@vcv/core";
import type { Permission } from "@vcv/core";
import { changedFilesSince } from "./git.ts";
import { JUNIT_LIMITS, parseJUnit } from "./junit.ts";
import type { JUnitCase } from "./junit.ts";
import { failFinal, finish, observed, readClaims } from "./proposals.ts";
import type { Observation, ProposalHooks, ProposalResult } from "./proposals.ts";
import { worktreeState } from "./worktree.ts";

export const TEST_RUN_LIMITS = { invocationChars: 2000, runnerChars: 100, recordBytes: 16 * 1024 * 1024 } as const;

export type CandidateIdentity = {
  commit: string | null;
  branch: string | null;
  /** Uncommitted paths (tracked edits and untracked files) and the digest of their bytes. */
  uncommitted: { paths: number; digest: string; complete: boolean };
  modelRevision: string;
  /** Digest of the binding claim files (which tests are mapped to what). */
  claims: string;
};

export type TestRunRecord = {
  format: "vcv-test-run-1";
  observedBy: "host" | "agent";
  principalId: string;
  runner: { name: string; version?: string };
  invocation: string;
  /** Repository-relative directory the report's test paths are relative to. */
  root: string;
  report: { format: "junit"; sha256: string; bytes: number };
  candidate: CandidateIdentity;
  identityDigest: string;
  summary: { tests: number; passed: number; failed: number; errors: number; skipped: number };
  cases: JUnitCase[];
  duplicates: string[];
  /** sha256 of the canonical record without this field. Detects accidental edits; it is not a signature. */
  digest: string;
};

export type TestRunHost = { principalId: string; permissions: readonly Permission[] };

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** The candidate's identity in one observation. */
export function candidateIdentityOf(obs: Observation): CandidateIdentity {
  const root = obs.status.root;
  const commit = obs.status.git?.commit ?? null;
  const dirty = commit ? (changedFilesSince(root, commit) ?? []) : [];
  const tree = worktreeState(root, dirty);
  return {
    commit,
    branch: obs.status.git?.branch ?? null,
    uncommitted: { paths: dirty.length, digest: tree.digest, complete: tree.complete },
    modelRevision: obs.model.project.modelRevision,
    claims: sha(readClaims(root).key),
  };
}
export const identityDigest = (c: CandidateIdentity) => sha(canonicalJson(c));

/** The candidate's identity now: read it before running the tests, and pass its digest to capture. */
export function testIdentity(path: string, hooks: ProposalHooks = {}): ProposalResult<{ candidate: CandidateIdentity; identityDigest: string }> {
  return observed(path, hooks, (obs) => {
    const candidate = candidateIdentityOf(obs);
    return finish(obs, hooks, { candidate, identityDigest: identityDigest(candidate) }, { key: identityDigest(candidate), again: () => identityDigest(candidateIdentityOf(obs)) });
  });
}

export const captureRequest = z
  .object({
    root: z.string().max(1000).default(""),
    runner: z.object({ name: z.string().min(1).max(TEST_RUN_LIMITS.runnerChars), version: z.string().min(1).max(TEST_RUN_LIMITS.runnerChars).optional() }).strict(),
    invocation: z.string().min(1).max(TEST_RUN_LIMITS.invocationChars),
    /** testIdentity's digest read before the run; capture is refused if the candidate moved since. */
    before: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();
export type CaptureRequest = z.input<typeof captureRequest>;

/** Read a runner's report and bind it to the candidate as a test-run record. Writes nothing. */
export function captureTestRun(path: string, report: Uint8Array, input: unknown, host: TestRunHost, hooks: ProposalHooks = {}): ProposalResult<TestRunRecord> {
  const parsed = captureRequest.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, error: { code: "INVALID_REQUEST", message: "request does not match the test-run capture schema", details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } };
  }
  const req = parsed.data;
  return observed(path, hooks, (obs) => {
    const read = parseJUnit(report, req.root);
    if (!read.ok) return failFinal({ code: read.code === "UNSAFE_PATH" ? "UNSAFE_PATH" : read.code, message: read.message }, obs, hooks);
    const candidate = candidateIdentityOf(obs);
    const digest = identityDigest(candidate);
    if (req.before && req.before !== digest) {
      return failFinal({ code: "TEST_RUN_RACED", message: `the candidate changed between testIdentity (${req.before.slice(0, 12)}) and capture (${digest.slice(0, 12)}); the report may describe neither. Run the tests again` }, obs, hooks);
    }
    const body: Omit<TestRunRecord, "digest"> = {
      format: "vcv-test-run-1",
      observedBy: host.permissions.includes("tests:observe") ? "host" : "agent",
      principalId: host.principalId,
      runner: req.runner,
      invocation: req.invocation,
      root: req.root === "." ? "" : req.root.replace(/\/+$/, ""),
      report: { format: "junit", sha256: read.report.sha256, bytes: read.report.bytes },
      candidate,
      identityDigest: digest,
      summary: read.report.summary,
      cases: read.report.cases,
      duplicates: read.report.duplicates,
    };
    const record: TestRunRecord = { ...body, digest: sha(canonicalJson(body)) };
    return finish(obs, hooks, record, { key: digest, again: () => identityDigest(candidateIdentityOf(obs)) });
  });
}

const identitySchema = z
  .object({
    commit: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
    branch: z.string().max(1000).nullable(),
    uncommitted: z.object({ paths: z.number().int().min(0), digest: z.string().regex(/^[0-9a-f]{64}$/), complete: z.boolean() }).strict(),
    modelRevision: z.string().min(1).max(256),
    claims: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const caseSchema = z
  .object({
    key: z.string().regex(/^[0-9a-f]{64}$/),
    path: z.string().min(1).max(1000),
    name: z.string().min(1).max(JUNIT_LIMITS.nameChars),
    nameDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    status: z.enum(["passed", "failed", "error", "skipped"]),
    message: z.string().max(JUNIT_LIMITS.messageChars).optional(),
  })
  .strict();
export const testRunRecordSchema = z
  .object({
    format: z.literal("vcv-test-run-1"),
    observedBy: z.enum(["host", "agent"]),
    principalId: z.string().min(1).max(256),
    runner: z.object({ name: z.string().min(1).max(TEST_RUN_LIMITS.runnerChars), version: z.string().min(1).max(TEST_RUN_LIMITS.runnerChars).optional() }).strict(),
    invocation: z.string().min(1).max(TEST_RUN_LIMITS.invocationChars),
    root: z.string().max(1000),
    report: z.object({ format: z.literal("junit"), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().min(0) }).strict(),
    candidate: identitySchema,
    identityDigest: z.string().regex(/^[0-9a-f]{64}$/),
    summary: z.object({ tests: z.number().int().min(0), passed: z.number().int().min(0), failed: z.number().int().min(0), errors: z.number().int().min(0), skipped: z.number().int().min(0) }).strict(),
    cases: z.array(caseSchema).max(JUNIT_LIMITS.cases),
    duplicates: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(JUNIT_LIMITS.cases),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/**
 * Check a record handed back to VCV: shape, its own digest, its identity digest, and that its
 * cases add up to its summary. Returns the problem, or null. This does not authenticate it.
 */
export function recordProblem(r: TestRunRecord): string | null {
  const { digest, ...body } = r;
  if (sha(canonicalJson(body)) !== digest) return "the record's digest does not match its content (edited after capture?)";
  if (identityDigest(r.candidate) !== r.identityDigest) return "the record's identity digest does not match its candidate";
  const n = (s: string) => r.cases.filter((c) => c.status === s).length;
  const s = r.summary;
  if (s.tests !== r.cases.length || s.failed !== n("failed") || s.errors !== n("error") || s.skipped !== n("skipped") || s.passed !== n("passed")) return "the record's summary does not match its cases";
  return null;
}
