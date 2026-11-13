// Test runs as evidence (Issue #22, M4.3): a runner's per-case report, bound to what was tested.
//
// VCV runs no tests. The host (CI, or a person at a shell) runs the project's ordinary runner with
// a machine-readable reporter and hands VCV the report. `captureTestRun` reads it strictly
// (junit.ts) and binds it to the candidate it describes:
//
//   candidate   the Git commit, the identity of every uncommitted path (bytes, not mtimes), the model
//               revision and the set of binding claims, as one `identityDigest`;
//   provenance  the record DECLARES `observedBy: host` only when the capturing caller holds
//               `tests:observe`, otherwise `agent`. A declaration in a file proves nothing: anyone
//               can write one and recompute its digest. So a consumer treats a run as host-observed
//               only when it captured it itself, in this process (`isTrustedCapture`: the record
//               object returned by captureTestRun, unmodified). Every imported record, whatever it
//               declares, is a claim. The pre-merge gate (M4.4) captures in its own trusted job;
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
import { WORKTREE_LIMITS, worktreeStateDetail } from "./worktree.ts";

/** recordBytes bounds the record as written by the CLI (JSON, 2-space indent, trailing newline) and as read back. */
export const TEST_RUN_LIMITS = { invocationChars: 2000, runnerChars: 100, recordBytes: 16 * 1024 * 1024 } as const;

export type CandidateIdentity = {
  commit: string | null;
  branch: string | null;
  /** Uncommitted paths (tracked edits and untracked files Git does not ignore) and the digest of their bytes. */
  uncommitted: { paths: number; digest: string; complete: boolean };
  /**
   * Every path a binding claim points at (implementation, route, test files), by its bytes, whether
   * Git tracks, ignores or links it: an ignored bound file, or the in-checkout target of a tracked
   * link, changes the code under test without Git seeing it.
   */
  bound: { paths: number; digest: string; complete: boolean };
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

/**
 * The candidate's identity in one observation, and why it cannot identify the candidate's source
 * exactly, if it cannot: no Git commit (nothing to say which source this is), a failed Git read (never
 * taken as a clean tree), or more uncommitted bytes than are hashed (sizes and mtimes are not an
 * identity). A run is never bound to, or fresh against, an identity with a problem.
 */
export function candidateIdentityOf(obs: Observation): { candidate: CandidateIdentity; problem: string | null } {
  const root = obs.status.root;
  const commit = obs.status.git?.commit ?? null;
  const listed = commit ? changedFilesSince(root, commit) : null;
  const dirty = listed ?? [];
  const tree = worktreeStateDetail(root, dirty);
  const claims = readClaims(root);
  const boundPaths = [...new Set(claims.entries.flatMap((e) => (e.claim ? [e.claim.locator.path] : [])))];
  const bound = worktreeStateDetail(root, boundPaths);
  const unreadableClaims = claims.entries.filter((e) => !e.claim).length;
  const candidate: CandidateIdentity = {
    commit,
    branch: obs.status.git?.branch ?? null,
    uncommitted: {
      paths: dirty.length,
      digest: tree.digest,
      complete: tree.complete && tree.unreadable === 0 && listed !== null,
    },
    bound: {
      paths: boundPaths.length,
      digest: bound.digest,
      complete:
        bound.complete && bound.unreadable === 0 && unreadableClaims === 0 && !claims.key.startsWith("unreadable:"),
    },
    modelRevision: obs.model.project.modelRevision,
    claims: sha(claims.key),
  };
  const problem = !commit
    ? "the checkout has no Git commit; a test run is bound to a commit plus the bytes of its uncommitted and bound files"
    : listed === null
      ? "the uncommitted files could not be listed (git failed); an unknown tree is not a clean one"
      : !tree.complete || !bound.complete
        ? `the uncommitted or bound files exceed what is hashed (${WORKTREE_LIMITS.files} files / ${WORKTREE_LIMITS.totalBytes} bytes); sizes and mtimes do not identify their content`
        : tree.unreadable || bound.unreadable
          ? `${tree.unreadable + bound.unreadable} uncommitted or bound path(s) cannot be observed (unreadable, or a link that leaves the checkout or cannot be resolved), so their content is unknown`
          : claims.key.startsWith("unreadable:")
            ? "the binding claims cannot be read, so which files the tests depend on is unknown"
            : unreadableClaims
              ? `${unreadableClaims} claim file(s) cannot be read, so the files they bind are unknown`
              : null;
  return { candidate, problem };
}

/** Why a record's own candidate identity cannot be exact, or null. */
export function recordIdentityProblem(c: CandidateIdentity): string | null {
  if (!c.commit) return "the run names no Git commit";
  if (!c.uncommitted.complete) return "the run's uncommitted files were not completely hashed";
  if (!c.bound.complete) return "the run's bound files were not completely hashed";
  return null;
}

// Records this process captured for a host-observing caller, with the digest they had. Membership
// cannot be forged by JSON: only the very object captureTestRun returned is in it.
const captured = new WeakMap<object, string>();

/**
 * True only for a record object that captureTestRun returned in this process for a caller holding
 * `tests:observe`, unmodified since. Every imported record (parsed JSON, a copy) is false.
 */
export function isTrustedCapture(record: unknown): boolean {
  if (typeof record !== "object" || record === null) return false;
  const digest = captured.get(record);
  if (!digest) return false;
  const r = record as TestRunRecord;
  return r.digest === digest && r.observedBy === "host" && recordProblem(r) === null;
}
export const identityDigest = (c: CandidateIdentity) => sha(canonicalJson(c));

/** The candidate's identity now: read it before running the tests, and pass its digest to capture. */
export function testIdentity(
  path: string,
  hooks: ProposalHooks = {},
): ProposalResult<{ candidate: CandidateIdentity; identityDigest: string }> {
  return observed(path, hooks, (obs) => {
    const { candidate, problem } = candidateIdentityOf(obs);
    if (problem) return failFinal({ code: "SOURCE_IDENTITY_UNAVAILABLE", message: problem }, obs, hooks);
    return finish(
      obs,
      hooks,
      { candidate, identityDigest: identityDigest(candidate) },
      { key: identityDigest(candidate), again: () => identityDigest(candidateIdentityOf(obs).candidate) },
    );
  });
}

export const captureRequest = z
  .object({
    root: z.string().max(1000).default(""),
    runner: z
      .object({
        name: z.string().min(1).max(TEST_RUN_LIMITS.runnerChars),
        version: z.string().min(1).max(TEST_RUN_LIMITS.runnerChars).optional(),
      })
      .strict(),
    invocation: z.string().min(1).max(TEST_RUN_LIMITS.invocationChars),
    /** testIdentity's digest read before the run; capture is refused if the candidate moved since. */
    before: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export type CaptureRequest = z.input<typeof captureRequest>;

/** Read a runner's report and bind it to the candidate as a test-run record. Writes nothing. */
export function captureTestRun(
  path: string,
  report: Uint8Array,
  input: unknown,
  host: TestRunHost,
  hooks: ProposalHooks = {},
): ProposalResult<TestRunRecord> {
  const parsed = captureRequest.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "request does not match the test-run capture schema",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    };
  }
  const req = parsed.data;
  return observed(path, hooks, (obs) => {
    const read = parseJUnit(report, req.root);
    if (!read.ok)
      return failFinal(
        { code: read.code === "UNSAFE_PATH" ? "UNSAFE_PATH" : read.code, message: read.message },
        obs,
        hooks,
      );
    const { candidate, problem } = candidateIdentityOf(obs);
    if (problem)
      return failFinal(
        {
          code: "SOURCE_IDENTITY_UNAVAILABLE",
          message: `${problem}. Commit, or capture in a Git checkout with fewer uncommitted files`,
        },
        obs,
        hooks,
      );
    const digest = identityDigest(candidate);
    if (req.before && req.before !== digest) {
      return failFinal(
        {
          code: "TEST_RUN_RACED",
          message: `the candidate changed between testIdentity (${req.before.slice(0, 12)}) and capture (${digest.slice(0, 12)}); the report may describe neither. Run the tests again`,
        },
        obs,
        hooks,
      );
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
    // The record must fit what VCV reads back (as the CLI writes it).
    const bytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`);
    if (bytes > TEST_RUN_LIMITS.recordBytes) {
      return failFinal(
        {
          code: "REPORT_TOO_LARGE",
          message: `the test-run record would be ${bytes} bytes, more than the ${TEST_RUN_LIMITS.recordBytes} VCV reads back; split the run (e.g. one report per package)`,
        },
        obs,
        hooks,
      );
    }
    const out = finish(obs, hooks, record, {
      key: digest,
      again: () => identityDigest(candidateIdentityOf(obs).candidate),
    });
    if (out.ok && record.observedBy === "host") captured.set(out.data, record.digest);
    return out;
  });
}

const identitySchema = z
  .object({
    commit: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .nullable(),
    branch: z.string().max(1000).nullable(),
    uncommitted: z
      .object({ paths: z.number().int().min(0), digest: z.string().regex(/^[0-9a-f]{64}$/), complete: z.boolean() })
      .strict(),
    bound: z
      .object({ paths: z.number().int().min(0), digest: z.string().regex(/^[0-9a-f]{64}$/), complete: z.boolean() })
      .strict(),
    modelRevision: z.string().min(1).max(256),
    claims: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const caseSchema = z
  .object({
    key: z.string().regex(/^[0-9a-f]{64}$/),
    path: z.string().min(1).max(1000),
    name: z.string().min(1).max(JUNIT_LIMITS.nameChars),
    nameDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    status: z.enum(["passed", "failed", "error", "skipped"]),
    message: z.string().max(JUNIT_LIMITS.messageChars).optional(),
  })
  .strict();
export const testRunRecordSchema = z
  .object({
    format: z.literal("vcv-test-run-1"),
    observedBy: z.enum(["host", "agent"]),
    principalId: z.string().min(1).max(256),
    runner: z
      .object({
        name: z.string().min(1).max(TEST_RUN_LIMITS.runnerChars),
        version: z.string().min(1).max(TEST_RUN_LIMITS.runnerChars).optional(),
      })
      .strict(),
    invocation: z.string().min(1).max(TEST_RUN_LIMITS.invocationChars),
    root: z.string().max(1000),
    report: z
      .object({
        format: z.literal("junit"),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: z.number().int().min(0),
      })
      .strict(),
    candidate: identitySchema,
    identityDigest: z.string().regex(/^[0-9a-f]{64}$/),
    summary: z
      .object({
        tests: z.number().int().min(0),
        passed: z.number().int().min(0),
        failed: z.number().int().min(0),
        errors: z.number().int().min(0),
        skipped: z.number().int().min(0),
      })
      .strict(),
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
  if (sha(canonicalJson(body)) !== digest)
    return "the record's digest does not match its content (edited after capture?)";
  if (identityDigest(r.candidate) !== r.identityDigest)
    return "the record's identity digest does not match its candidate";
  const n = (s: string) => r.cases.filter((c) => c.status === s).length;
  const s = r.summary;
  if (
    s.tests !== r.cases.length ||
    s.failed !== n("failed") ||
    s.errors !== n("error") ||
    s.skipped !== n("skipped") ||
    s.passed !== n("passed")
  )
    return "the record's summary does not match its cases";
  return null;
}
