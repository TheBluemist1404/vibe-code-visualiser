// The result envelope every @vcv/repo read and write returns.
//
// A call either succeeds with data, or fails with a coded error. Both carry the context they
// were observed in (project, model revision, Git state) whenever the project could be read.
import type { Model } from "@vcv/ir";
import type { z } from "zod";
import type { ProjectStatus } from "../project.ts";

export type RepoErrorCode =
  | "INVALID_REQUEST"
  /** The project is absent, uninitialized, conflicted, diverged or invalid. */
  | "PROJECT_NOT_READY"
  /** No change record with this ID in this checkout. */
  | "UNKNOWN_CHANGE"
  /** The change record file exists but cannot be read as a record. */
  | "INVALID_RECORD"
  /** The model store could not be read. */
  | "STORE_ERROR"
  /** The checkout, model store, change records or claims changed while reading (e.g. a Git checkout). Nothing was mixed; retry. */
  | "STATE_CHANGED"
  // Handoff and implementation reports:
  /** The change is not applied (pending, rejected): there is nothing approved to implement. */
  | "NOT_APPLIED"
  /** The change's resulting revision is not in this checkout's model history (another branch?). */
  | "NOT_IN_HISTORY"
  /** The change has no attestation whose signature verifies against its record. */
  | "NOT_ATTESTED"
  /** A commit named in the request is not in this repository, or not an ancestor of HEAD. */
  | "UNKNOWN_COMMIT"
  /** An implementation report for this change exists; pass its digest to replace it. */
  | "REPORT_EXISTS"
  /** The existing report's digest is not the one passed. */
  | "REPORT_CHANGED"
  /** The implementations directory or report file is not a plain directory/file. */
  | "UNSAFE_PATH"
  /** No implementation report for this change. */
  | "NO_REPORT"
  /** The handoff would exceed its byte limit even with every derived list cut. */
  | "HANDOFF_TOO_LARGE"
  /** The reconciliation report would exceed its byte budget even with every list cut. */
  | "REPORT_TOO_LARGE"
  /** A test report that cannot be read as the supported JUnit XML subset. */
  | "REPORT_INVALID"
  /** A test report whose declared counts do not match its cases (truncated or edited). */
  | "REPORT_INCONSISTENT"
  /** The candidate changed between reading its identity and capturing the run. */
  | "TEST_RUN_RACED"
  /** A test-run record that does not check (shape, digest, summary). */
  | "RUN_INVALID"
  /** The candidate's source cannot be identified exactly (no Git commit, a failed Git read, too much to hash). */
  | "SOURCE_IDENTITY_UNAVAILABLE"
  /** The gate policy does not match vcv-policy-1, or cannot be read. */
  | "POLICY_INVALID";

export type RepoError = { code: RepoErrorCode; message: string; details?: { path: string; message: string }[] };

export type RepoContext = {
  projectId: string;
  /** The revision .vcv/HEAD names in this checkout now. */
  modelRevision: string;
  /** The model snapshot's own status. Says nothing about any change record's approval. */
  snapshotStatus: string;
  /** A fixed label kept for output compatibility (reports and recorded samples carry it). */
  source: "model-proposals";
  /** Always false: nothing here looks at code. */
  implementationChecked: false;
  observed: { commit: string | null; branch: string | null; dirty: boolean | null };
};

export type RepoResult<T> =
  | { ok: true; context: RepoContext; data: T }
  | { ok: false; context?: RepoContext; error: RepoError };

export function contextOf(status: ProjectStatus, model: Model): RepoContext {
  return {
    projectId: model.project.id,
    modelRevision: model.project.modelRevision,
    snapshotStatus: model.project.status,
    source: "model-proposals",
    implementationChecked: false,
    observed: {
      commit: status.git?.commit ?? null,
      branch: status.git?.branch ?? null,
      dirty: status.git?.dirty ?? null,
    },
  };
}

/** A success with the context of this status and model. */
export function okWith<T>(status: ProjectStatus, model: Model, data: T): RepoResult<T> {
  return { ok: true, context: contextOf(status, model), data };
}

/** The project is not ready (absent, uninitialized, conflicted, diverged, invalid). */
export function notReady<T>(status: ProjectStatus): RepoResult<T> {
  const why = status.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => d.message)
    .join("; ");
  return {
    ok: false,
    error: { code: "PROJECT_NOT_READY", message: `the VCV project is ${status.state}${why ? `: ${why}` : ""}` },
  };
}

/** A request that does not match its zod schema; `maxIssues` caps the listed details. */
/** The failure every request schema mismatch returns; it fits each result envelope in this package. */
export type InvalidRequest = {
  ok: false;
  error: { code: "INVALID_REQUEST"; message: string; details: { path: string; message: string }[] };
};

export function invalidRequest(
  error: z.ZodError,
  message = "request does not match the input schema",
  maxIssues = Number.POSITIVE_INFINITY,
): InvalidRequest {
  return {
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message,
      details: error.issues.slice(0, maxIssues).map((i) => ({ path: i.path.join("."), message: i.message })),
    },
  };
}
