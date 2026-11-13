// Read-only integrity check of a checkout's `.vcv/` history (Issue #17, M3.2).
//
// Usable locally and in CI. It checks what is deterministically provable from the repository
// (and, for trust, from a source the change under review cannot alter), and says plainly what is
// not provable. It is baseline *model integrity*, not M4's reconciliation of model and code.
//
// Per revision after the first:
//   derivation  exactly one applied change record names it as its result; the record's base is
//               the previous revision; replaying the record's typed operations on that revision
//               with the engine's own checkChange() yields exactly this revision's content (and,
//               for branch-safe IDs, this ID). Anything else is a hand-written or rewritten
//               revision, or a forged record.
//   approval    a signed attestation (approval.ts) for that change: well-formed, matching the
//               record and the proposal digest, signature valid, key listed for the approver in
//               the trust source, approver different from proposer. Missing means unknown
//               provenance, never "approved".
// Store-wide: the store is ready (HEAD, revisions and records readable and verified), HEAD's last
// commit is the applied record of the HEAD revision, no applied record points outside the
// history, no stray attestations, and, with a base ref, the base's history is an unchanged prefix.
import {
  canonicalJson,
  checkChange,
  listChangeRecords,
  proposalDigest,
  proposedChangeSchema,
  revisionDigest,
  FileStoreReader,
  readStoreFile,
  STORE_FILE_LIMITS,
} from "@vcv/core";
import type { ChangeRecord } from "@vcv/core";
import type { Model } from "@vcv/ir";
import { readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVALS_DIR,
  ApprovalError,
  MAX_ATTESTATION_BYTES,
  TRUST_VERIFICATION,
  keyFingerprint,
  loadTrust,
  readAttestation,
  signatureValid,
} from "./approval.ts";
import type { LoadedTrust, TrustSource } from "./approval.ts";
import { fileAtCommit, filesAtCommit, isAncestor, resolveCommit } from "./git.ts";
import { VCV_DIR, projectStatus } from "./project.ts";

export type IntegrityProblem = {
  code: string;
  severity: "error" | "warning";
  message: string;
  revision?: string;
  changeId?: string;
};

export type ApprovalCheck =
  /** Valid signature by a key the trust source lists for the recorded approver, who is not the proposer. */
  | "attested"
  /** No attestation file: who approved is unknown (a direct apply, a developer `vcv approve`, or a removed file). */
  | "missing"
  /** The signature is valid, but the key is not listed for this approver in the trust source. */
  | "untrusted-key"
  /** No trust source was available, so a valid signature cannot be tied to a reviewer. */
  | "trust-unavailable"
  /** The file is unreadable, its signature does not verify, or it does not match the record. */
  | "invalid";

export type RevisionCheck = {
  seq: number;
  revision: string;
  changeId: string | null;
  /** Revisions after the base ref's HEAD (all derived revisions without a base). */
  introduced: boolean;
  derivation:
    | "initial"
    | "verified"
    | "no-record"
    | "ambiguous"
    | "base-mismatch"
    | "invalid-change"
    | "failed"
    | "mismatch";
  /** What the change record says (not proof). */
  recorded: { proposerId: string; approverId: string | null } | null;
  approval: { state: ApprovalCheck | "not-applicable"; approverId?: string; keyFingerprint?: string; detail: string };
};

export type IntegrityReport = {
  ok: boolean;
  projectId: string | null;
  revision: string | null;
  revisions: RevisionCheck[];
  problems: IntegrityProblem[];
  trust: {
    source: string;
    reviewers: number;
    protectedFromCheckout: boolean;
    authority: LoadedTrust["authority"];
    verification: typeof TRUST_VERIFICATION;
    anchor: string;
    commit: string | null;
  } | null;
  /**
   * What `ok` means for authorization. `ok` says the history is consistent and attested under
   * the given anchor; it authorizes only when the host supplied that anchor (CI on the protected
   * branch). This field says so on every report.
   */
  authorization: string;
  base: { ref: string; commit: string; revision: string | null; history: string[] } | null;
  requireAttestation: boolean;
  /** What this check cannot establish. Always read with the result. */
  limits: string[];
};

export type IntegrityOptions = {
  /** Trust list for attestations. Default: none (attestations are then "trust-unavailable"). */
  trust?: TrustSource;
  /** A Git ref (e.g. origin/main) whose `.vcv/` history must be an unchanged prefix of this one. */
  base?: string;
  /** Make every introduced revision without a trusted attestation an error (default: warning). */
  requireAttestation?: boolean;
};

const AUTHORIZATION =
  "caller-asserted: ok means consistent and attested under the trust anchor given here; it authorizes a change only when that anchor (and --base) is supplied by the host from the hosting service's protected branch, in a check the change under review cannot edit";

const LIMITS = [
  "An attestation proves that the holder of a trusted reviewer key signed this exact change; it does not prove which person held the key, or that the key was not shared or stolen.",
  "Trust is only as strong as its source. A trust list in the checkout under review can be changed by that same change; in CI, read it from the protected base branch (--trust-ref) and protect who may change it there. Git pins the commit the list was read from; it cannot prove that the branch is protected. An unpinned --trust-ref is a local name anyone with a shell in the checkout can create or move: rely on it only where the host provides the ref (a CI checkout), or pin it with --trust-commit.",
  "The initial revision has no recorded derivation: who created it, and from what, is not provable from the repository.",
  "Derivation replays the recorded typed operations; it says nothing about whether the source code implements the model (that is M4's reconciliation).",
  "The local audit log (.vcv/audit.jsonl) is not shared through Git and is not evidence here.",
];

/** Check a checkout's `.vcv/` history. Read-only: no recovery, no writes, no network. */
export function checkIntegrity(path: string, opts: IntegrityOptions = {}): IntegrityReport {
  const problems: IntegrityProblem[] = [];
  const err = (code: string, message: string, extra: Partial<IntegrityProblem> = {}) =>
    problems.push({ code, severity: "error", message, ...extra });
  const warn = (code: string, message: string, extra: Partial<IntegrityProblem> = {}) =>
    problems.push({ code, severity: "warning", message, ...extra });
  const requireAttestation = !!opts.requireAttestation;
  const report = (over: Partial<IntegrityReport>): IntegrityReport => ({
    ok: !problems.some((p) => p.severity === "error"),
    projectId: null,
    revision: null,
    revisions: [],
    problems,
    trust: null,
    base: null,
    requireAttestation,
    authorization: AUTHORIZATION,
    limits: LIMITS,
    ...over,
  });

  const status = projectStatus(path);
  if (status.state !== "ready" || !status.model) {
    const why = status.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => d.message)
      .join("; ");
    err("STORE_NOT_READY", `the VCV project is ${status.state}${why ? `: ${why}` : ""}`);
    return report({});
  }
  const storeDir = status.storeDir;
  let reader: FileStoreReader;
  let history: string[];
  const models: Model[] = [];
  try {
    reader = new FileStoreReader(storeDir);
    history = reader.revisions();
    for (const rev of history) models.push(reader.revision(rev)!);
  } catch (e) {
    err("STORE_NOT_READY", `the model store could not be read: ${(e as Error).message}`);
    return report({});
  }
  const projectId = models.at(-1)!.project.id;
  const revision = history.at(-1)!;

  // Trust.
  let trust: LoadedTrust | null = null;
  if (opts.trust) {
    try {
      trust = loadTrust(status.root, opts.trust);
      if (!trust.protectedFromCheckout) {
        // A strict check cannot accept trust the change under review controls.
        (requireAttestation ? err : warn)(
          "TRUST_FROM_CHECKOUT",
          `the trust list (${trust.source}) cannot establish trusted approval: ${trust.unprotectedReason}; use --trust-ref <protected base> or a file outside the checkout`,
        );
      }
    } catch (e) {
      err(e instanceof ApprovalError ? e.code : "INVALID_TRUST", (e as Error).message);
    }
  }

  // Base.
  let base: IntegrityReport["base"] = null;
  let baseHistory: string[] = [];
  if (opts.base !== undefined) {
    const commit = resolveCommit(status.root, opts.base);
    if (!commit) err("UNKNOWN_REF", `${opts.base} is not a commit in this repository`);
    else {
      const headBytes = fileAtCommit(status.root, commit, `${VCV_DIR}/HEAD`, STORE_FILE_LIMITS.head);
      let baseRev: string | null = null;
      if (headBytes) {
        try {
          const h = JSON.parse(headBytes.toString("utf8")) as { revision?: unknown; history?: unknown };
          if (
            !Array.isArray(h.history) ||
            !h.history.every((x) => typeof x === "string") ||
            typeof h.revision !== "string"
          )
            throw new Error("bad");
          baseHistory = h.history as string[];
          baseRev = h.revision;
        } catch {
          err("BASE_UNREADABLE", `${VCV_DIR}/HEAD at ${opts.base} is not a valid HEAD`);
        }
      }
      base = { ref: opts.base, commit, revision: baseRev, history: baseHistory };
      const prefix = baseHistory.every((r, i) => history[i] === r);
      if (!prefix)
        err(
          "BASE_HISTORY_REWRITTEN",
          `the base's model history (${baseHistory.join(" → ")}) is not a prefix of this checkout's (${history.join(" → ")}); history was rewritten or replaced`,
        );
      else {
        for (const rev of baseHistory) {
          const theirs = fileAtCommit(
            status.root,
            commit,
            `${VCV_DIR}/revisions/${rev}.yaml`,
            STORE_FILE_LIMITS.revision,
          );
          const ours = readStoreFile(storeDir, `revisions/${rev}.yaml`, STORE_FILE_LIMITS.revision);
          if (!theirs || ours.kind !== "file" || !theirs.equals(ours.bytes)) {
            err(
              "BASE_REVISION_CHANGED",
              `revision ${rev} differs from the base's copy at ${opts.base}; committed revisions are never rewritten`,
              { revision: rev },
            );
          }
        }
        baseEvidence(status.root, storeDir, commit, opts.base, err);
      }
    }
  }

  // With a base, a Git trust anchor must be that base (or an ancestor of it): the trust list that
  // governs a change is the one the change is merged into, never one the branch chose for itself.
  if (base && trust?.commit && !isAncestor(status.root, trust.commit, base.commit)) {
    (requireAttestation ? err : warn)(
      "TRUST_NOT_FROM_BASE",
      `the trust list's commit ${trust.commit.slice(0, 12)} is not ${base.ref} (${base.commit.slice(0, 12)}) or one of its ancestors; read trust from the base under check`,
    );
  }

  // Records.
  const entries = listChangeRecords(storeDir);
  const applied = new Map<string, ChangeRecord[]>();
  for (const e of entries) {
    const r = e.record;
    if (r?.status === "applied" && typeof r.resultingRevision === "string")
      applied.set(r.resultingRevision, [...(applied.get(r.resultingRevision) ?? []), r]);
  }
  for (const [rev, rs] of applied) {
    if (!history.includes(rev))
      for (const r of rs)
        err("ORPHAN_APPLIED_RECORD", `change ${r.changeId} says it produced ${rev}, which is not in this history`, {
          changeId: r.changeId,
          revision: rev,
        });
  }

  // Revisions.
  const revisions: RevisionCheck[] = [];
  const baseSet = new Set(baseHistory);
  for (let i = 0; i < history.length; i++) {
    const rev = history[i]!;
    const introduced = opts.base !== undefined ? !baseSet.has(rev) : i > 0;
    if (i === 0) {
      if (applied.has(rev))
        warn("INITIAL_HAS_RECORD", `a change record claims to have produced the initial revision ${rev}`, {
          revision: rev,
        });
      revisions.push({
        seq: 1,
        revision: rev,
        changeId: null,
        introduced,
        derivation: "initial",
        recorded: null,
        approval: { state: "not-applicable", detail: "initial revision (created by init; provenance not provable)" },
      });
      if (introduced)
        warn(
          "INITIAL_INTRODUCED",
          `the initial revision ${rev} is new relative to the base: the whole model is new and its origin is not provable`,
          { revision: rev },
        );
      continue;
    }
    const parent = history[i - 1]!;
    const rs = applied.get(rev) ?? [];
    const check: RevisionCheck = {
      seq: i + 1,
      revision: rev,
      changeId: null,
      introduced,
      derivation: "verified",
      recorded: null,
      approval: { state: "not-applicable", detail: "" },
    };
    revisions.push(check);
    if (rs.length === 0) {
      check.derivation = "no-record";
      check.approval = { state: "missing", detail: "no change record" };
      err(
        "UNEXPLAINED_REVISION",
        `no applied change record produced ${rev}: it was written by hand, or its record was removed`,
        { revision: rev },
      );
      continue;
    }
    if (rs.length > 1) {
      check.derivation = "ambiguous";
      check.approval = { state: "invalid", detail: "several records claim this revision" };
      err(
        "AMBIGUOUS_REVISION",
        `${rs.length} change records (${rs.map((r) => r.changeId).join(", ")}) claim to have produced ${rev}`,
        { revision: rev },
      );
      continue;
    }
    const r = rs[0]!;
    check.changeId = r.changeId;
    check.recorded = { proposerId: r.proposerId, approverId: r.approverId ?? null };
    if (r.baseRevision !== parent) {
      check.derivation = "base-mismatch";
      err("BASE_MISMATCH", `change ${r.changeId} was based on ${r.baseRevision}, but ${rev} follows ${parent}`, {
        revision: rev,
        changeId: r.changeId,
      });
    } else {
      const parsed = proposedChangeSchema.safeParse(r.change);
      if (!parsed.success) {
        check.derivation = "invalid-change";
        err("INVALID_CHANGE", `change ${r.changeId} does not hold a typed change, so ${rev} cannot be derived`, {
          revision: rev,
          changeId: r.changeId,
        });
      } else {
        const derived = checkChange(parsed.data, models[i - 1]!);
        if (!derived.model) {
          check.derivation = "failed";
          err(
            "DERIVATION_FAILED",
            `replaying change ${r.changeId} on ${parent} fails (${derived.errors.map((d) => d.code).join(", ")})`,
            { revision: rev, changeId: r.changeId },
          );
        } else if (revisionDigest(derived.model, parent) !== revisionDigest(models[i]!, parent)) {
          check.derivation = "mismatch";
          err(
            "DERIVATION_MISMATCH",
            `${rev} is not what change ${r.changeId}'s operations produce from ${parent}: the revision or the record was edited`,
            { revision: rev, changeId: r.changeId },
          );
        }
      }
    }
    check.approval = approvalCheck(storeDir, r, rev, trust, !!opts.trust);
    const a = check.approval;
    if (a.state !== "attested") {
      const msg = `${rev} (change ${r.changeId}): approval ${a.state}: ${a.detail}`;
      // An attestation that is present but does not verify is evidence of tampering: always an error.
      if (a.state === "invalid") err("APPROVAL_INVALID", msg, { revision: rev, changeId: r.changeId });
      else if (introduced && requireAttestation)
        err("APPROVAL_NOT_ATTESTED", msg, { revision: rev, changeId: r.changeId });
      else if (introduced) warn("APPROVAL_NOT_ATTESTED", msg, { revision: rev, changeId: r.changeId });
    }
  }

  // HEAD's last commit is the record of the HEAD revision.
  const headFile = readStoreFile(storeDir, "HEAD", STORE_FILE_LIMITS.head);
  if (headFile.kind === "file") {
    const last = (JSON.parse(headFile.text) as { lastCommit?: ChangeRecord }).lastCommit;
    const headRecord = (applied.get(revision) ?? [])[0];
    if (history.length > 1 && !last) warn("HEAD_WITHOUT_LAST_COMMIT", "HEAD does not record its last commit");
    else if (last && (!headRecord || canonicalJson(last) !== canonicalJson(headRecord))) {
      err("HEAD_RECORD_MISMATCH", `HEAD's last commit (${last.changeId}) is not the applied record of ${revision}`, {
        revision,
      });
    }
  }

  // Attestations for changes that did not produce a revision here.
  const attested = new Set(revisions.map((c) => c.changeId).filter(Boolean));
  for (const f of listDir(join(storeDir, APPROVALS_DIR))) {
    const id = f.replace(/\.json$/, "");
    if (f.endsWith(".json") && !attested.has(id))
      warn(
        "STRAY_ATTESTATION",
        `${VCV_DIR}/${APPROVALS_DIR}/${f} attests a change that produced no revision in this history`,
        { changeId: id },
      );
  }

  return report({
    projectId,
    revision,
    revisions,
    trust: trust
      ? {
          source: trust.source,
          reviewers: trust.list.reviewers.length,
          protectedFromCheckout: trust.protectedFromCheckout,
          authority: trust.authority,
          verification: TRUST_VERIFICATION,
          anchor: trust.anchor,
          commit: trust.commit ?? null,
        }
      : null,
    base,
  });
}

/**
 * The base's settled evidence must survive unchanged: every attestation, and every change record
 * the base already settled (applied or rejected). A pending record may still be decided on the
 * branch, so it may change. Legacy unattested base revisions are not required to gain one.
 */
function baseEvidence(
  root: string,
  storeDir: string,
  commit: string,
  ref: string,
  err: (code: string, message: string, extra?: Partial<IntegrityProblem>) => void,
) {
  const check = (sub: string, max: number, settledOnly: boolean) => {
    for (const rel of filesAtCommit(root, commit, `${VCV_DIR}/${sub}`)) {
      if (!rel.endsWith(".json")) continue;
      const name = rel.slice(VCV_DIR.length + 1);
      const changeId = rel.slice(rel.lastIndexOf("/") + 1, -".json".length);
      const theirs = fileAtCommit(root, commit, rel, max);
      if (!theirs) continue; // oversized on the base: the base itself is not readable evidence
      if (settledOnly) {
        let st: unknown;
        try {
          st = (JSON.parse(theirs.toString("utf8")) as { status?: unknown }).status;
        } catch {
          st = "unreadable";
        }
        if (st === "pending") continue;
      }
      const ours = readStoreFile(storeDir, name, max);
      if (ours.kind === "absent")
        err(
          "BASE_EVIDENCE_REMOVED",
          `${rel} exists at ${ref} but was removed here; the base's ${sub === APPROVALS_DIR ? "approval attestations" : "settled change records"} are never removed`,
          { changeId },
        );
      else if (ours.kind !== "file" || !theirs.equals(ours.bytes))
        err(
          "BASE_EVIDENCE_CHANGED",
          `${rel} differs from its copy at ${ref}; the base's ${sub === APPROVALS_DIR ? "approval attestations" : "settled change records"} are never rewritten`,
          { changeId },
        );
    }
  };
  check(APPROVALS_DIR, MAX_ATTESTATION_BYTES, false);
  check("changes", STORE_FILE_LIMITS.change, true);
}

function listDir(dir: string): string[] {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return [];
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export function approvalCheck(
  storeDir: string,
  r: ChangeRecord,
  rev: string,
  trust: LoadedTrust | null,
  trustRequested: boolean,
): RevisionCheck["approval"] {
  const read = readAttestation(storeDir, r.changeId);
  if (!read)
    return {
      state: "missing",
      detail: r.approverId
        ? `record names ${r.approverId}, but there is no attestation: provenance unknown`
        : "applied without a separate approver and without an attestation: provenance unknown",
    };
  if (!read.attestation) return { state: "invalid", detail: read.problem! };
  const a = read.attestation;
  const fp = keyFingerprint(a.publicKey);
  const base = { approverId: a.approverId, keyFingerprint: fp };
  const mismatch = [
    a.changeId !== r.changeId && "changeId",
    a.projectId !== r.projectId && "projectId",
    a.proposalDigest !== proposalDigest(r.change) && "proposalDigest",
    a.proposerId !== r.proposerId && "proposerId",
    a.approverId !== r.approverId && "approverId",
    a.baseRevision !== r.baseRevision && "baseRevision",
    a.resultingRevision !== rev && "resultingRevision",
    a.keyFingerprint !== fp && "keyFingerprint",
  ].filter(Boolean);
  if (mismatch.length)
    return { ...base, state: "invalid", detail: `attestation does not match the record (${mismatch.join(", ")})` };
  if (!signatureValid(a)) return { ...base, state: "invalid", detail: "signature does not verify" };
  if (a.approverId === a.proposerId) return { ...base, state: "invalid", detail: "approver is the proposer" };
  if (!trust)
    return {
      ...base,
      state: "trust-unavailable",
      detail: trustRequested ? "the trust list could not be loaded" : "no trust source given (--trust or --trust-ref)",
    };
  const entry = trust.list.reviewers.find((x) => x.publicKey === a.publicKey);
  if (!entry || entry.id !== a.approverId || !entry.permissions.includes("model:approve")) {
    return {
      ...base,
      state: "untrusted-key",
      detail: `key ${fp} is not listed for ${a.approverId} in ${trust.source}`,
    };
  }
  return { ...base, state: "attested", detail: `signed by ${a.approverId} (key ${fp}), trusted per ${trust.source}` };
}
