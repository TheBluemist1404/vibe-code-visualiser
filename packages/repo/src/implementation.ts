// The implementation evidence report (Issue #17, M3.3).
//
// After implementing an approved change, the coding agent records one bounded report, linked to
// the approved revision and change ID, at `.vcv/implementations/<changeId>.json` (committed with
// the code). It keeps four things apart, and none implies another:
//
//   approvedIntent   what was approved: the operations and the implementation request, from the
//                    change record (covered by the reviewed proposal digest);
//   agentClaims      what the agent says it did: tests it ran and their outcomes, acceptance
//                    criteria it considers met, gaps, explanations, its confidence. Recorded as
//                    claimed by the host-asserted principal; VCV runs nothing and verifies none;
//   vcvObserved      what VCV can see now: files changed since the base commit, which of them are
//                    outside the approved scope, and the binding claims on the changed objects as
//                    verifyBinding reports them (resolved / stale / missing…, reasserted or not);
//   notReconciled    always: whether the code implements the model is M4's reconciliation.
//
// It warns rather than passes silently: out-of-scope changes, an undeclared scope, stale or
// unreasserted bindings, failed or missing tests, unmet or unaddressed criteria, a model that
// moved. Code changes never become model operations; recording a report changes no model state.
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { persistedIdProblem, persistedIdSchema } from "@vcv/ir";
import { implementationRequestSchema, proposalDigest } from "@vcv/core";
import type { HostContext, ImplementationRequest } from "@vcv/core";
import { isAncestor, resolveCommit } from "./git.ts";
import { VCV_DIR } from "./project.ts";
import { affectedBindings, approvedChange, attestationKey, digestOf, guardOf, redact, worktreeOf } from "./handoff.ts";
import type { ApprovedChange, HandoffBinding } from "./handoff.ts";
import { describeOperation, failFinal, finish, observed, readClaims } from "./proposals.ts";
import type { Observation, ProposalError, ProposalHooks, ProposalResult } from "./proposals.ts";
import type { WorktreeState } from "./worktree.ts";

export const IMPLEMENTATIONS_DIR = "implementations";
export const IMPLEMENTATION_LIMITS = { files: 500, reportBytes: 256 * 1024 } as const;

const line = (max: number) => z.string().min(1).max(max);
const repoPath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) => !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\\"),
    "must be a repository-relative path",
  );

/** What the implementing agent writes (a JSON file of its own). Strict and bounded. */
export const implementationReportInput = z
  .object({
    changeId: persistedIdSchema,
    /** The `git.baseCommit` from the handoff the agent worked from (full ID). */
    baseCommit: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/),
    /** The handoff's digest, linking the report to the brief the agent received. */
    handoffDigest: z.string().regex(/^[0-9a-f]{64}$/),
    testsRun: z
      .array(
        z
          .object({
            command: line(500),
            outcome: z.enum(["passed", "failed", "error", "not-run"]),
            summary: line(2000).optional(),
          })
          .strict(),
      )
      .max(50),
    acceptance: z
      .array(
        z
          .object({
            criterion: line(500),
            status: z.enum(["met", "not-met", "unknown"]),
            evidence: line(1000).optional(),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    gaps: z.array(line(1000)).max(30).optional(),
    outOfScope: z
      .array(z.object({ path: repoPath, reason: line(1000) }).strict())
      .max(50)
      .optional(),
    confidence: z.enum(["low", "medium", "high"]),
    notes: line(4000).optional(),
  })
  .strict();

export type ImplementationReportInput = z.infer<typeof implementationReportInput>;

export type ImplementationWarning = { code: string; message: string; path?: string; bindingId?: string };

export type ImplementationObservation = {
  baseCommit: string;
  headCommit: string | null;
  branch: string | null;
  dirty: boolean | null;
  modelRevision: string;
  /** Source files changed since the base commit (working tree included), outside `.vcv/`. */
  filesModified: string[];
  filesTruncated: boolean;
  /** Changed source files the approved scope does not cover (all of them when no scope was declared). */
  outOfScope: string[];
  /** `.vcv/` files changed since the base commit, by area. */
  store: { bindings: string[]; model: string[]; other: string[] };
  /**
   * The bytes observed: every changed file and every bound source file, by content (or by size
   * and mtime past the budget). Ties the report to one concrete dirty source state; rechecked
   * before the report is written or shown.
   */
  worktree: WorktreeState;
  bindings: (HandoffBinding & { claimedAtRevision: string | null; reasserted: boolean })[];
};

export type ImplementationReport = {
  format: 1;
  kind: "vcv-implementation-report";
  changeId: string;
  approvedRevision: string;
  proposalDigest: string;
  handoffDigest: string;
  approvedIntent: { request: ImplementationRequest | null; operations: string[]; note: string };
  agentClaims: Omit<ImplementationReportInput, "changeId" | "baseCommit" | "handoffDigest"> & {
    claimedBy: string;
    verifiedByVcv: false;
    note: string;
  };
  vcvObserved: ImplementationObservation & { note: string };
  notReconciled: { state: "not-reconciled"; note: string };
  warnings: ImplementationWarning[];
};

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const commitId = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);
const text = (max = 8000) => z.string().max(max);
const paths = z.array(text(1000)).max(IMPLEMENTATION_LIMITS.files);
const observedBinding = z
  .object({
    bindingId: text(200),
    modelObjectId: text(200),
    relation: text(100),
    locator: text(2000),
    why: z.enum(["changed", "removed", "impacted"]),
    state: text(100),
    source: text(100).nullable(),
    model: text(100).nullable(),
    reassertAfterImplementing: z.boolean(),
    claimedAtRevision: text(200).nullable(),
    reasserted: z.boolean(),
  })
  .strict();

/** A recorded report, as read back: validated completely before any field is used. */
export const persistedImplementationReport = z
  .object({
    format: z.literal(1),
    kind: z.literal("vcv-implementation-report"),
    changeId: persistedIdSchema,
    approvedRevision: text(200),
    proposalDigest: hex64,
    handoffDigest: hex64,
    approvedIntent: z
      .object({
        request: implementationRequestSchema.nullable(),
        operations: z.array(text()).max(10_000),
        note: text(),
      })
      .strict(),
    agentClaims: implementationReportInput
      .omit({ changeId: true, baseCommit: true, handoffDigest: true })
      .extend({ claimedBy: text(500), verifiedByVcv: z.literal(false), note: text() })
      .strict(),
    vcvObserved: z
      .object({
        baseCommit: commitId,
        headCommit: commitId.nullable(),
        branch: text(1000).nullable(),
        dirty: z.boolean().nullable(),
        modelRevision: text(200),
        filesModified: paths,
        filesTruncated: z.boolean(),
        outOfScope: paths,
        store: z.object({ bindings: paths, model: paths, other: paths }).strict(),
        worktree: z.object({ digest: hex64, files: z.number().int().nonnegative(), complete: z.boolean() }).strict(),
        bindings: z.array(observedBinding).max(10_000),
        note: text(),
      })
      .strict(),
    notReconciled: z.object({ state: z.literal("not-reconciled"), note: text() }).strict(),
    warnings: z
      .array(
        z
          .object({ code: text(100), message: text(), path: text(1000).optional(), bindingId: text(200).optional() })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

export type RecordImplementationResult = {
  file: string;
  digest: string;
  report: ImplementationReport;
  replaced: boolean;
};

/**
 * Record (or, with `expected` = the existing file's digest, replace) the implementation report of
 * an applied, attested change. One observation; the store and claims are rechecked before the
 * write (STATE_CHANGED). Writes only `.vcv/implementations/<changeId>.json`.
 */
export function recordImplementation(
  path: string,
  input: unknown,
  host: HostContext,
  expected: string | null = null,
  hooks: ProposalHooks = {},
): ProposalResult<RecordImplementationResult> {
  const parsed = implementationReportInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "the report does not match the implementation report schema (docs/implementation.md)",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    };
  }
  const req = parsed.data;
  return observed(path, hooks, (obs) => {
    const attestation = attestationKey(obs, req.changeId);
    const brief = approvedChange(obs, req.changeId);
    if ("error" in brief) return failFinal(brief.error, obs, hooks);
    const claims = readClaims(obs.status.root);
    const seen = observe(obs, brief, req.baseCommit, claims.entries);
    if ("error" in seen) return failFinal(seen.error, obs, hooks);
    const observation = seen.observation;

    const dir = join(obs.status.storeDir, IMPLEMENTATIONS_DIR);
    const file = join(dir, `${req.changeId}.json`);
    const existing = readPlain(file);
    if (existing.kind === "unsafe") return failFinal({ code: "UNSAFE_PATH", message: existing.problem }, obs, hooks);
    if (existing.kind === "file" && expected === null)
      return failFinal(
        {
          code: "REPORT_EXISTS",
          message: `${VCV_DIR}/${IMPLEMENTATIONS_DIR}/${req.changeId}.json exists (digest ${digestBytes(existing.bytes)}); pass --expect <digest> to replace it`,
        },
        obs,
        hooks,
      );
    if (existing.kind === "file" && expected !== digestBytes(existing.bytes))
      return failFinal(
        {
          code: "REPORT_CHANGED",
          message: `the existing report's digest is ${digestBytes(existing.bytes)}, not ${expected}`,
        },
        obs,
        hooks,
      );
    if (existing.kind === "absent" && expected !== null)
      return failFinal({ code: "NO_REPORT", message: `there is no report for ${req.changeId} to replace` }, obs, hooks);

    const report = redact(assemble(brief, req, host, observation), obs.status.root);
    const body = JSON.stringify(report, null, 2) + "\n";
    if (Buffer.byteLength(body) > IMPLEMENTATION_LIMITS.reportBytes)
      return failFinal(
        {
          code: "INVALID_REQUEST",
          message: `the report would be larger than ${IMPLEMENTATION_LIMITS.reportBytes} bytes; shorten the claims`,
        },
        obs,
        hooks,
      );
    // What is written must read back: the same schema `vcv implementation show` applies.
    const self = persistedImplementationReport.safeParse(report);
    if (!self.success)
      return failFinal(
        {
          code: "INVALID_REQUEST",
          message: "the report would not read back as a valid report (after redaction)",
          details: issues(self.error),
        },
        obs,
        hooks,
      );

    // Recheck store, commit, records, claims, attestation and working tree (files and bytes).
    const done = finish(obs, hooks, null, guardOf(obs, req.changeId, attestation, req.baseCommit, claims, seen.tree));
    if (!done.ok) return done as ProposalResult<RecordImplementationResult>;
    // The report file is part of the guard too: re-read it right before writing, so a report
    // written since it was checked is never overwritten (exclusive link for a new one).
    const now = readPlain(file);
    if (existing.kind === "file" && (now.kind !== "file" || digestBytes(now.bytes) !== digestBytes(existing.bytes))) {
      return {
        ok: false,
        context: done.context,
        error: {
          code: "REPORT_CHANGED",
          message: `${VCV_DIR}/${IMPLEMENTATIONS_DIR}/${req.changeId}.json changed while the replacement was prepared; nothing was written, read it again and retry`,
        },
      };
    }
    if (existing.kind === "absent" && now.kind !== "absent") {
      return {
        ok: false,
        context: done.context,
        error: {
          code: "REPORT_EXISTS",
          message: `${VCV_DIR}/${IMPLEMENTATIONS_DIR}/${req.changeId}.json appeared while the report was prepared; nothing was written`,
        },
      };
    }
    try {
      const st = lstatOrNull(dir);
      if (st && (st.isSymbolicLink() || !st.isDirectory()))
        return {
          ok: false,
          context: done.context,
          error: { code: "UNSAFE_PATH", message: `${VCV_DIR}/${IMPLEMENTATIONS_DIR}/ is not a plain directory` },
        };
      if (!st) mkdirSync(dir);
      writeFile(file, body, existing.kind === "file");
    } catch (e) {
      return {
        ok: false,
        context: done.context,
        error: {
          code: (e as NodeJS.ErrnoException).code === "EEXIST" ? "REPORT_EXISTS" : "UNSAFE_PATH",
          message: `the report was not written: ${(e as Error).message}`,
        },
      };
    }
    return {
      ok: true,
      context: done.context,
      data: {
        file: `${VCV_DIR}/${IMPLEMENTATIONS_DIR}/${req.changeId}.json`,
        digest: digestBytes(Buffer.from(body)),
        report,
        replaced: existing.kind === "file",
      },
    };
  });
}

export type ImplementationStatus = {
  file: string;
  digest: string;
  report: ImplementationReport;
  /** What VCV observes now, from the report's base commit. */
  now: ImplementationObservation;
  /** True when the observed facts differ from those recorded (files, scope, binding states). */
  changedSinceReport: boolean;
  warningsNow: ImplementationWarning[];
};

/** Read a recorded report and recompute VCV's observations now. Read-only, one observation. */
export function implementationStatus(
  path: string,
  changeId: string,
  hooks: ProposalHooks = {},
): ProposalResult<ImplementationStatus> {
  return observed(path, hooks, (obs) => {
    if (persistedIdProblem(changeId))
      return failFinal({ code: "UNKNOWN_CHANGE", message: `no change "${changeId}"` }, obs, hooks);
    const rel = `${VCV_DIR}/${IMPLEMENTATIONS_DIR}/${changeId}.json`;
    const f = readPlain(join(obs.status.storeDir, IMPLEMENTATIONS_DIR, `${changeId}.json`));
    if (f.kind === "absent")
      return failFinal({ code: "NO_REPORT", message: `no implementation report ${rel}` }, obs, hooks);
    if (f.kind === "unsafe") return failFinal({ code: "UNSAFE_PATH", message: f.problem }, obs, hooks);
    let raw: unknown;
    try {
      raw = JSON.parse(f.bytes.toString("utf8"));
    } catch (e) {
      return failFinal(
        { code: "INVALID_RECORD", message: `${rel} is not valid JSON: ${(e as Error).message}` },
        obs,
        hooks,
      );
    }
    const parsedReport = persistedImplementationReport.safeParse(raw);
    if (!parsedReport.success)
      return failFinal(
        {
          code: "INVALID_RECORD",
          message: `${rel} is not a valid implementation report; record it again with vcv implementation record --expect ${digestBytes(f.bytes)}`,
          details: issues(parsedReport.error),
        },
        obs,
        hooks,
      );
    const report = parsedReport.data as ImplementationReport;
    if (report.changeId !== changeId)
      return failFinal(
        { code: "INVALID_RECORD", message: `${rel} is the report of ${report.changeId}, not ${changeId}` },
        obs,
        hooks,
      );
    const attestation = attestationKey(obs, changeId);
    const brief = approvedChange(obs, changeId);
    if ("error" in brief) return failFinal(brief.error, obs, hooks);
    const claims = readClaims(obs.status.root);
    const seen = observe(obs, brief, report.vcvObserved.baseCommit, claims.entries);
    if ("error" in seen) return failFinal(seen.error, obs, hooks);
    const nowRedacted = redact(seen.observation, obs.status.root);
    const file = join(obs.status.storeDir, IMPLEMENTATIONS_DIR, `${changeId}.json`);
    const reportGuard = {
      key: digestBytes(f.bytes),
      again: () => {
        const g = readPlain(file);
        return g.kind === "file" ? digestBytes(g.bytes) : g.kind;
      },
    };
    const { note: _n, headCommit: _h, dirty: _d, ...recorded } = report.vcvObserved;
    const { headCommit: _h2, dirty: _d2, ...current } = nowRedacted;
    const agent = {
      ...report.agentClaims,
      changeId,
      baseCommit: report.vcvObserved.baseCommit,
      handoffDigest: report.handoffDigest,
    };
    return finish(
      obs,
      hooks,
      {
        file: rel,
        digest: digestBytes(f.bytes),
        report,
        now: nowRedacted,
        changedSinceReport: digestOf(recorded) !== digestOf(current),
        warningsNow: warningsFor(brief, agent as ImplementationReportInput, nowRedacted),
      },
      guardOf(obs, changeId, attestation, report.vcvObserved.baseCommit, claims, seen.tree, reportGuard),
    );
  });
}

const issues = (e: z.ZodError) => e.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message }));

// ---- observation and warnings ------------------------------------------------------------

type Seen = { observation: ImplementationObservation; tree: NonNullable<ReturnType<typeof worktreeOf>> };

function observe(
  obs: Observation,
  brief: ApprovedChange,
  baseCommit: string,
  entries: ReturnType<typeof readClaims>["entries"],
): Seen | { error: ProposalError } {
  const root = obs.status.root;
  if (!obs.status.git)
    return {
      error: {
        code: "UNKNOWN_COMMIT",
        message: "the checkout is not a Git repository: there is no base commit to compare with",
      },
    };
  if (resolveCommit(root, baseCommit) !== baseCommit)
    return { error: { code: "UNKNOWN_COMMIT", message: `base commit ${baseCommit} is not in this repository` } };
  if (obs.commit && !isAncestor(root, baseCommit, obs.commit))
    return {
      error: {
        code: "UNKNOWN_COMMIT",
        message: `base commit ${baseCommit.slice(0, 12)} is not an ancestor of HEAD (${obs.commit.slice(0, 12)}): record the report on the branch that was implemented`,
      },
    };
  // Snapshot the changed files and the bound sources (bytes) before binding verification reads them.
  const tree = worktreeOf(obs, baseCommit, entries);
  if (!tree)
    return { error: { code: "UNKNOWN_COMMIT", message: `cannot compare the working tree with ${baseCommit}` } };
  const changed = tree.changed;
  const store = { bindings: [] as string[], model: [] as string[], other: [] as string[] };
  const source: string[] = [];
  for (const f of changed) {
    if (f === VCV_DIR || f.startsWith(`${VCV_DIR}/`)) {
      const sub = f.slice(VCV_DIR.length + 1);
      if (sub.startsWith("bindings/")) store.bindings.push(f);
      else if (
        sub === "HEAD" ||
        sub.startsWith("revisions/") ||
        sub.startsWith("changes/") ||
        sub.startsWith("approvals/")
      )
        store.model.push(f);
      else store.other.push(f);
    } else source.push(f);
  }
  const scope = brief.request?.scope ?? null;
  const matchers = (scope ?? []).map(globMatcher);
  const outOfScope = scope ? source.filter((f) => !matchers.some((m) => m(f))) : [...source];
  const approved = brief.record.resultingRevision;
  const at = obs.history.indexOf(approved);
  const bindings = affectedBindings(obs, brief, entries).map((b) => {
    const claim = entries.find((e) => e.bindingId === b.bindingId)?.claim ?? null;
    const claimedAt = claim?.modelRevision ?? null;
    // Reasserted: the claim was (re)made at the approved revision or later, i.e. after approval.
    const reasserted = claimedAt !== null && obs.history.indexOf(claimedAt) >= at && at >= 0;
    return { ...b, claimedAtRevision: claimedAt, reasserted };
  });
  const cap = <T>(xs: T[]) => xs.slice(0, IMPLEMENTATION_LIMITS.files);
  const observation: ImplementationObservation = {
    baseCommit,
    headCommit: obs.commit,
    branch: obs.status.git.branch ?? null,
    dirty: obs.status.git.dirty ?? null,
    modelRevision: obs.model.project.modelRevision,
    filesModified: cap(source),
    filesTruncated: source.length > IMPLEMENTATION_LIMITS.files,
    outOfScope: cap(outOfScope),
    store: { bindings: cap(store.bindings), model: cap(store.model), other: cap(store.other) },
    worktree: tree.state,
    bindings,
  };
  return { observation, tree };
}

function warningsFor(
  brief: ApprovedChange,
  req: ImplementationReportInput,
  o: ImplementationObservation,
): ImplementationWarning[] {
  const w: ImplementationWarning[] = [];
  const explained = new Map((req.outOfScope ?? []).map((x) => [x.path, x.reason]));
  if (!brief.request)
    w.push({
      code: "NO_IMPLEMENTATION_REQUEST",
      message:
        "the approved change carried no implementation request: there were no approved acceptance criteria or scope",
    });
  else if (!brief.request.scope)
    w.push({
      code: "SCOPE_NOT_DECLARED",
      message: "the approved request declared no code scope, so every changed file is unscoped",
    });
  for (const f of o.outOfScope) {
    const why = explained.get(f);
    w.push({
      code: "OUT_OF_SCOPE",
      path: f,
      message: `${f} changed outside the approved scope${why ? ` (agent's explanation: ${why})` : ""}`,
    });
  }
  if (o.filesModified.length === 0)
    w.push({ code: "NO_SOURCE_CHANGES", message: "no source file changed since the base commit" });
  if (o.filesTruncated)
    w.push({
      code: "FILES_TRUNCATED",
      message: `more than ${IMPLEMENTATION_LIMITS.files} files changed; the lists are cut`,
    });
  if (o.modelRevision !== brief.record.resultingRevision) {
    w.push({
      code: "MODEL_MOVED",
      message: `the model is at ${o.modelRevision}, not the approved ${brief.record.resultingRevision}: later model changes need their own proposal, review and report`,
    });
  }
  if (o.store.other.length)
    w.push({ code: "STORE_FILES_CHANGED", message: `other .vcv/ files changed: ${o.store.other.join(", ")}` });
  if (o.bindings.length === 0)
    w.push({
      code: "NO_BINDINGS",
      message: "no binding claim points at the changed or impacted objects: VCV cannot locate the implementing code",
    });
  for (const b of o.bindings) {
    if (b.state !== "resolved")
      w.push({ code: "BINDING_NOT_RESOLVED", bindingId: b.bindingId, message: `${b.bindingId} is ${b.state} now` });
    if (b.reassertAfterImplementing && !b.reasserted)
      w.push({
        code: "BINDING_NOT_REASSERTED",
        bindingId: b.bindingId,
        message: `${b.bindingId} (on ${b.why} ${b.modelObjectId}) was last claimed at ${b.claimedAtRevision ?? "?"}, before the approved revision: re-inspect and reassert it`,
      });
  }
  if (!req.testsRun.some((t) => t.outcome === "passed" || t.outcome === "failed" || t.outcome === "error"))
    w.push({ code: "NO_TESTS_RUN", message: "the agent reports no test run" });
  for (const t of req.testsRun)
    if (t.outcome === "failed" || t.outcome === "error")
      w.push({ code: "TEST_FAILED", message: `${t.command}: ${t.outcome} (agent's report)` });
  const criteria = brief.request?.acceptanceCriteria ?? [];
  const addressed = new Map((req.acceptance ?? []).map((a) => [a.criterion, a.status]));
  for (const c of criteria) {
    const s = addressed.get(c);
    if (!s)
      w.push({ code: "CRITERION_UNADDRESSED", message: `acceptance criterion not addressed in the report: ${c}` });
    else if (s !== "met")
      w.push({
        code: s === "not-met" ? "CRITERION_NOT_MET" : "CRITERION_UNKNOWN",
        message: `${c}: ${s} (agent's report)`,
      });
  }
  for (const g of req.gaps ?? []) w.push({ code: "GAP", message: g });
  w.push({
    code: "CLAIMS_UNVERIFIED",
    message: "tests, outcomes and acceptance are the agent's claims: VCV ran nothing and verified none of them",
  });
  return w;
}

function assemble(
  brief: ApprovedChange,
  req: ImplementationReportInput,
  host: HostContext,
  o: ImplementationObservation,
): ImplementationReport {
  const r = brief.record;
  const ops = (r.change as { operations: Parameters<typeof describeOperation>[0][] }).operations.map(describeOperation);
  const { changeId: _c, baseCommit: _b, handoffDigest, ...claims } = req;
  return {
    format: 1,
    kind: "vcv-implementation-report",
    changeId: r.changeId,
    approvedRevision: r.resultingRevision,
    proposalDigest: proposalDigest(r.change),
    handoffDigest,
    approvedIntent: {
      request: brief.request,
      operations: ops,
      note: "What the reviewer approved (covered by the proposal digest). Not a statement about the code.",
    },
    agentClaims: {
      ...claims,
      claimedBy: host.principalId,
      verifiedByVcv: false,
      note: "The implementing agent's own account, as asserted by its host. VCV ran nothing and verified none of it.",
    },
    vcvObserved: {
      ...o,
      note: "What VCV observed when the report was recorded: changed files from the base commit, scope, and binding claims verified as locator facts (meaning unverified).",
    },
    notReconciled: {
      state: "not-reconciled",
      note: "Whether the source implements the approved model is not established by anything here (M4 reconciliation).",
    },
    warnings: warningsFor(brief, req, o),
  };
}

// ---- helpers ---------------------------------------------------------------------------

/** Match a repository-relative path against a path or glob (`*`, `**`, `?`); a plain path also matches everything below it. */
export function globMatcher(pattern: string): (path: string) => boolean {
  const p = pattern.replace(/\/+$/, "");
  if (!/[*?]/.test(p)) return (f) => f === p || f.startsWith(`${p}/`);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*" && p[i + 1] === "*") {
      const slash = p[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const rx = new RegExp(`^${re}$`);
  return (f) => rx.test(f);
}

/** sha256 of the file's bytes: what a later replace passes as --expect. */
const digestBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function readPlain(
  path: string,
): { kind: "absent" } | { kind: "unsafe"; problem: string } | { kind: "file"; bytes: Buffer } {
  const dir = lstatOrNull(dirname(path));
  if (dir && (dir.isSymbolicLink() || !dir.isDirectory()))
    return { kind: "unsafe", problem: `${VCV_DIR}/${IMPLEMENTATIONS_DIR}/ is not a plain directory` };
  const st = lstatOrNull(path);
  if (!st) return { kind: "absent" };
  if (st.isSymbolicLink() || !st.isFile())
    return { kind: "unsafe", problem: `${path.slice(path.lastIndexOf(VCV_DIR))} is not a regular file` };
  if (st.size > IMPLEMENTATION_LIMITS.reportBytes)
    return { kind: "unsafe", problem: "the report is larger than its limit" };
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return { kind: "unsafe", problem: "the report is not a regular file" };
    const buf = Buffer.alloc(IMPLEMENTATION_LIMITS.reportBytes + 1);
    let n = 0;
    for (let k; (k = readSync(fd, buf, n, buf.length - n, null)) > 0; ) n += k;
    if (n > IMPLEMENTATION_LIMITS.reportBytes)
      return { kind: "unsafe", problem: "the report is larger than its limit" };
    return { kind: "file", bytes: buf.subarray(0, n) };
  } finally {
    closeSync(fd);
  }
}

/** Durable write: exclusive for a new report; replace (rename) only after the digest check. */
function writeFile(path: string, text: string, replace: boolean): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (replace) renameSync(tmp, path);
    else linkSync(tmp, path);
  } finally {
    if (!replace) unlinkSync(tmp);
  }
}
