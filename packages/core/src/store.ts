// Persistence for model revisions, change records and the attempt log.
//
// FileStore layout (all text, suitable for committing to Git):
//   <dir>/HEAD                      commit point: current revision, full history, last applied ChangeRecord
//   <dir>/revisions/<rev>.yaml      one file per model revision, never rewritten once committed
//   <dir>/changes/<changeId>.json   current state of each proposal (derivable for the last commit)
//   <dir>/audit.jsonl               append-only log of every propose/approve attempt (best effort)
//   <dir>/orphaned/                 uncommitted leftovers moved aside by recovery, kept for inspection
//
// Commit protocol (single writer; see docs/adr/0003-persistence.md):
//   1. write revisions/<rev>.yaml        (temp file + fsync + rename)
//   2. write HEAD                        (temp file + fsync + rename)  ← the commit point
//   3. write changes/<changeId>.json     (temp file + fsync + rename)
// A revision exists if and only if HEAD lists it. Anything else on disk is either a leftover
// from an interrupted commit (moved to orphaned/) or derivable from HEAD (repaired). Recovery
// runs every time a FileStore is opened, so a failed commit can simply be retried.
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dumpModel, loadModel, persistedIdProblem } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import type { AuditEvent, ChangeRecord } from "./engine.ts";
import { nextRevision } from "./engine.ts";
import { canonicalJson, isChildRevision, parseRevisionId } from "./revisions.ts";

export type StoreErrorCode =
  | "INVALID_ID"
  | "CORRUPT"
  | "REVISION_EXISTS"
  | "NOT_INITIALIZED"
  | "ALREADY_INITIALIZED"
  | "BAD_COMMIT"
  /** A store file contains Git conflict markers (an unresolved merge). */
  | "CONFLICTED"
  /** The store holds revisions that are not in HEAD's history and are not an interrupted commit. */
  | "DIVERGED"
  /** HEAD on disk moved under an open writer (Git checkout/pull, another process); nothing was written. */
  | "HEAD_CHANGED"
  /** Other store files changed under an open writer after validation (e.g. a merge or a same-ID swap); nothing was written. */
  | "STORE_CHANGED";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "StoreError";
  }
}

/**
 * One consistent read of the store: the current model, the history it heads and an opaque token
 * for exactly this state. The engine validates a change against a snapshot and commits with its
 * token, so the store can refuse if anything moved in between (ADR 0007 §2).
 */
export type StoreSnapshot = { model: Model; history: string[]; token: string };

/** Preconditions for a non-committing record write (ADR 0007 §2). */
export type ChangeGuard = { token: string; previous: ChangeRecord | null };

export interface ModelStore {
  current(): Model;
  snapshot(): StoreSnapshot;
  revision(rev: string): Model | undefined;
  /** Committed revisions, oldest first. */
  revisions(): string[];
  /**
   * Atomically make `model` the current revision, recording the applied change. With `token`
   * (from snapshot()), refuse unless the store is still in exactly that state.
   */
  commit(model: Model, record: ChangeRecord, token?: string): void;
  getChange(changeId: string): ChangeRecord | undefined;
  /**
   * Persist a non-committing record state (pending, rejected). With a guard, refuse
   * (STORE_CHANGED, nothing written) unless the store is still in the snapshot's state and the
   * record on disk is exactly `previous` (null: no record with that ID exists).
   */
  putChange(record: ChangeRecord, guard?: ChangeGuard): void;
  appendAudit(event: AuditEvent): void;
  audit(): AuditEvent[];
}

function assertPersistedId(kind: string, value: string): void {
  const problem = persistedIdProblem(value);
  if (problem) throw new StoreError("INVALID_ID", `${kind} "${value}" ${problem}`);
}

function assertCommittable(model: Model, record: ChangeRecord, history: readonly string[]) {
  const rev = model.project.modelRevision;
  assertPersistedId("revision", rev);
  assertPersistedId("change id", record.changeId);
  if (record.status !== "applied" || record.resultingRevision !== rev) {
    throw new StoreError("BAD_COMMIT", `commit needs an applied record whose resultingRevision is ${rev}`);
  }
  if (history.includes(rev)) throw new StoreError("REVISION_EXISTS", `revision ${rev} already exists`);
  // The model must have been derived from the revision the store holds now: never append a model
  // validated against another line (or an earlier state) to this one.
  const head = history.at(-1)!;
  if (record.baseRevision !== head) {
    throw new StoreError("HEAD_CHANGED", `change ${record.changeId} was validated against ${record.baseRevision}, but the store is now at ${head}; nothing was written`);
  }
  if (parseRevisionId(rev).scheme === "branch-safe" && !isChildRevision(rev, model, head, history.length + 1)) {
    throw new StoreError("BAD_COMMIT", `${rev} is not the digest of this model as revision ${history.length + 1} after ${head}; nothing was written`);
  }
}

// ---------------------------------------------------------------------------------------

export class MemoryStore implements ModelStore {
  private readonly revs = new Map<string, Model>();
  private readonly order: string[] = [];
  private readonly changes = new Map<string, ChangeRecord>();
  private readonly log: AuditEvent[] = [];

  constructor(initial: Model) {
    assertPersistedId("revision", initial.project.modelRevision);
    this.revs.set(initial.project.modelRevision, structuredClone(initial));
    this.order.push(initial.project.modelRevision);
  }
  current(): Model {
    return structuredClone(this.revs.get(this.order.at(-1)!)!);
  }
  revision(rev: string): Model | undefined {
    const m = this.revs.get(rev);
    return m && structuredClone(m);
  }
  revisions(): string[] {
    return [...this.order];
  }
  snapshot(): StoreSnapshot {
    return { model: this.current(), history: this.revisions(), token: this.order.join("\0") };
  }
  commit(model: Model, record: ChangeRecord, token?: string): void {
    if (token !== undefined && token !== this.order.join("\0")) {
      throw new StoreError("HEAD_CHANGED", "the store moved since the snapshot this change was validated against; nothing was written");
    }
    assertCommittable(model, record, this.order);
    this.revs.set(model.project.modelRevision, structuredClone(model));
    this.order.push(model.project.modelRevision);
    this.changes.set(record.changeId, structuredClone(record));
  }
  getChange(id: string): ChangeRecord | undefined {
    assertPersistedId("change id", id);
    const r = this.changes.get(id);
    return r && structuredClone(r);
  }
  putChange(record: ChangeRecord, guard?: ChangeGuard): void {
    assertPersistedId("change id", record.changeId);
    if (guard) {
      const onDisk = this.changes.get(record.changeId);
      if (guard.token !== this.order.join("\0") || !sameRecord(onDisk ?? null, guard.previous)) {
        throw new StoreError("STORE_CHANGED", `change ${record.changeId} or the store changed since validation; nothing was written`);
      }
    }
    this.changes.set(record.changeId, structuredClone(record));
  }
  appendAudit(event: AuditEvent): void {
    this.log.push(structuredClone(event));
  }
  audit(): AuditEvent[] {
    return structuredClone(this.log);
  }
}

// ---------------------------------------------------------------------------------------

type Head = { format: 1; revision: string; history: string[]; lastCommit?: ChangeRecord };

/** Named points in the commit protocol where a test can simulate a crash. */
export type CommitStep =
  | "revision.write"
  | "revision.rename"
  | "head.write"
  | "head.rename"
  | "change.write"
  | "change.rename";

export type FileStoreOptions = {
  /** Test hook: called before each step of a commit; throwing simulates a crash at that point. */
  beforeStep?: (step: CommitStep) => void;
};

export type RecoveryReport = {
  removedTempFiles: string[];
  orphanedRevisions: string[];
  orphanedChangeRecords: string[];
  repairedChangeRecords: string[];
};

export class FileStore implements ModelStore {
  private readonly dir: string;
  private readonly opts: FileStoreOptions;
  private head: Head;
  /** storeFingerprint() at the last successful validation (open, sync) or own write. */
  private validated = "";
  /** What recovery found and fixed when this store was opened. */
  readonly recovery: RecoveryReport;

  constructor(dir: string, opts: FileStoreOptions = {}) {
    this.dir = dir;
    this.opts = opts;
    if (!existsSync(join(dir, "HEAD"))) throw new StoreError("NOT_INITIALIZED", `${dir} is not an initialized model store (run init first)`);
    this.head = this.readHead();
    this.recovery = this.recover();
    this.validated = storeFingerprint(dir);
  }

  static init(dir: string, initial: Model, opts: FileStoreOptions = {}): FileStore {
    if (existsSync(join(dir, "HEAD"))) throw new StoreError("ALREADY_INITIALIZED", `${dir} already holds a model store`);
    const rev = initial.project.modelRevision;
    assertPersistedId("revision", rev);
    for (const sub of ["revisions", "changes", "orphaned"]) mkdirSync(join(dir, sub), { recursive: true });
    durableWrite(join(dir, "revisions", `${rev}.yaml`), dumpModel(initial));
    const head: Head = { format: 1, revision: rev, history: [rev] };
    durableWrite(join(dir, "HEAD"), JSON.stringify(head, null, 2) + "\n"); // initialized only once HEAD exists
    return new FileStore(dir, opts);
  }

  // Read policy for long-lived writers (ADR 0007 §2): every read first follows HEAD on disk, so
  // after a `git checkout` the engine validates against the checked-out line (a change based on
  // the old line then fails its expectedRevision check). A moved HEAD is re-checked with
  // recovery, so a conflicted or diverged checkout is refused here too.
  current(): Model {
    this.sync();
    return this.revision(this.head.revision)!;
  }

  revision(rev: string): Model | undefined {
    this.sync();
    if (!this.head.history.includes(rev)) return undefined; // uncommitted files do not exist
    return readRevisionFile(this.dir, rev, this.head.history);
  }

  revisions(): string[] {
    this.sync();
    return [...this.head.history];
  }

  snapshot(): StoreSnapshot {
    this.sync();
    return { model: readRevisionFile(this.dir, this.head.revision, this.head.history), history: [...this.head.history], token: this.validated };
  }

  commit(model: Model, record: ChangeRecord, token?: string): void {
    // Write guard: the change was validated against this.head. If HEAD on disk moved since then
    // (checkout, pull, another process), writing would replace that line's HEAD. Refuse before
    // touching any file.
    // The fingerprint also covers the other store files, so a merge that only added revisions or
    // a same-ID revision swap after validation is refused too.
    const disk = readHeadFile(this.dir);
    if (!sameLine(disk, this.head)) {
      throw new StoreError(
        "HEAD_CHANGED",
        `HEAD moved from ${this.head.revision} to ${disk.revision} on disk since this change was validated (Git checkout, pull or another writer); nothing was written. Re-read the model and retry.`,
      );
    }
    assertCommittable(model, record, this.head.history);
    const fp = storeFingerprint(this.dir);
    if (fp !== this.validated || (token !== undefined && token !== fp)) {
      throw new StoreError(
        "STORE_CHANGED",
        "model store files changed on disk since this change was validated (for example a Git merge or checkout); nothing was written. Re-read the model and retry.",
      );
    }
    const rev = model.project.modelRevision;
    const next: Head = { format: 1, revision: rev, history: [...this.head.history, rev], lastCommit: record };

    this.write("revision", join(this.dir, "revisions", `${rev}.yaml`), dumpModel(model));
    this.write("head", join(this.dir, "HEAD"), JSON.stringify(next, null, 2) + "\n");
    this.head = next; // committed: from here on the revision exists
    this.write("change", this.changePath(record.changeId), JSON.stringify(record, null, 2) + "\n");
    this.validated = storeFingerprint(this.dir); // our own writes are known-good
  }

  getChange(id: string): ChangeRecord | undefined {
    const p = this.changePath(id);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as ChangeRecord;
    } catch {
      throw new StoreError("CORRUPT", `change record ${id} is unreadable`);
    }
  }

  putChange(record: ChangeRecord, guard?: ChangeGuard): void {
    if (record.status === "applied") throw new StoreError("BAD_COMMIT", "applied records are written only by commit()");
    const path = this.changePath(record.changeId);
    const before = storeFingerprint(this.dir);
    if (guard) {
      // A Git checkout after validation could put another branch's record under this ID; never
      // overwrite it, and never write into a store state other than the one validated against.
      let onDisk: ChangeRecord | null = null;
      if (existsSync(path)) {
        try {
          onDisk = JSON.parse(readFileSync(path, "utf8")) as ChangeRecord;
        } catch {
          onDisk = { changeId: "\0unreadable" } as ChangeRecord;
        }
      }
      if (before !== this.validated || guard.token !== before || !sameRecord(onDisk, guard.previous)) {
        throw new StoreError(
          "STORE_CHANGED",
          `change ${record.changeId} or other store files changed on disk since validation (for example a Git checkout); nothing was written. Re-read and retry.`,
        );
      }
    }
    durableWrite(path, JSON.stringify(record, null, 2) + "\n");
    // Only bless our own write if nothing else had changed; otherwise the next read re-checks.
    if (before === this.validated) this.validated = storeFingerprint(this.dir);
  }

  appendAudit(event: AuditEvent): void {
    const fd = openSync(join(this.dir, "audit.jsonl"), "a+");
    try {
      // If an earlier append was cut short, the file ends mid-line. Start a fresh line so the
      // torn fragment stays on its own (skipped on read) and cannot swallow this event.
      const { size } = fstatSync(fd);
      let prefix = "";
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      }
      appendFileSync(fd, prefix + JSON.stringify(event) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  audit(): AuditEvent[] {
    const p = join(this.dir, "audit.jsonl");
    if (!existsSync(p)) return [];
    const out: AuditEvent[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as AuditEvent);
      } catch {
        // A crash mid-append can leave one torn line; skip it rather than lose the log.
      }
    }
    return out;
  }

  /**
   * Bring the directory back in line with HEAD. Idempotent; safe to run at any time with
   * no writer active.
   */
  recover(): RecoveryReport {
    return this.recoverFor(this.head);
  }

  /**
   * Check and repair the directory against `head`. All refusals (conflict markers, divergence,
   * missing or unverifiable revisions) are raised before anything is moved or rewritten.
   */
  private recoverFor(head: Head): RecoveryReport {
    const report: RecoveryReport = { removedTempFiles: [], orphanedRevisions: [], orphanedChangeRecords: [], repairedChangeRecords: [] };
    mkdirSync(join(this.dir, "orphaned"), { recursive: true });
    mkdirSync(join(this.dir, "changes"), { recursive: true });

    // 1. Temp files are never committed content.
    for (const sub of ["", "revisions", "changes"]) {
      for (const f of readdirSync(join(this.dir, sub))) {
        if (f.includes(".tmp-")) {
          rmSync(join(this.dir, sub, f));
          report.removedTempFiles.push(join(sub, f));
        }
      }
    }

    // 2. Revision files HEAD does not list. Only the one an interrupted commit leaves (the next
    //    child of HEAD) is moved aside. Anything else came from another line of history, for
    //    example a Git merge resolved to one side's HEAD; moving it would silently drop that
    //    branch's model, so refuse and let a person decide (ADR 0007).
    const committed = new Set(head.history);
    const conflicted = conflictedFiles(this.dir);
    if (conflicted.length) throw conflictError(conflicted);
    const unlisted = unlistedRevisions(this.dir, head);
    const foreign = unlisted.filter((u) => u.kind === "foreign");
    if (foreign.length) throw divergedError(foreign);
    for (const rev of head.history) {
      if (!existsSync(join(this.dir, "revisions", `${rev}.yaml`))) {
        throw new StoreError("CORRUPT", `HEAD lists revision ${rev} but its file is missing`);
      }
      readRevisionFile(this.dir, rev, head.history); // parses and verifies branch-safe digests
    }
    for (const u of unlisted) {
      renameSync(join(this.dir, "revisions", u.file), join(this.dir, "orphaned", `revision.${u.file}`));
      report.orphanedRevisions.push(u.id);
    }

    // 3. An "applied" record must point at a committed revision.
    for (const f of readdirSync(join(this.dir, "changes"))) {
      const id = f.replace(/\.json$/, "");
      const rec = this.getChange(id);
      if (rec?.status === "applied" && !committed.has(rec.resultingRevision ?? "")) {
        renameSync(join(this.dir, "changes", f), join(this.dir, "orphaned", `change.${f}`));
        report.orphanedChangeRecords.push(id);
      }
    }

    // 4. The last commit's record is derivable from HEAD; rewrite it if step 3 of commit was lost.
    const last = head.lastCommit;
    if (last) {
      const onDisk = this.getChange(last.changeId);
      if (onDisk?.status !== "applied" || onDisk.resultingRevision !== last.resultingRevision) {
        durableWrite(this.changePath(last.changeId), JSON.stringify(last, null, 2) + "\n");
        report.repairedChangeRecords.push(last.changeId);
      }
    }
    return report;
  }

  private readHead(): Head {
    return readHeadFile(this.dir);
  }

  /** Adopt HEAD as it is on disk now, re-running the open-time checks if it moved. */
  //
  // The new HEAD is adopted only after its checks pass. If they fail, the store keeps the last
  // validated line, so every later read compares against it again and fails again, and commit()
  // refuses with HEAD_CHANGED: a rejected checkout is never served or written over.
  //
  // "Moved" means any store file changed, not just HEAD's line: a merge resolved to this
  // writer's own HEAD adds foreign revisions without touching HEAD (round 4 of the PR #8 review).
  private sync(): void {
    const fp = storeFingerprint(this.dir);
    if (fp === this.validated) return;
    const disk = readHeadFile(this.dir);
    this.recoverFor(disk);
    this.head = disk;
    this.validated = storeFingerprint(this.dir); // recovery may have moved a leftover
  }

  private changePath(id: string): string {
    assertPersistedId("change id", id);
    return join(this.dir, "changes", `${id}.json`);
  }

  private write(step: "revision" | "head" | "change", path: string, text: string) {
    durableWrite(path, text, (phase) => this.opts.beforeStep?.(`${step}.${phase}`));
  }
}

/**
 * A read-only view of a FileStore directory for query adapters (MCP, future UI readers).
 *
 * Unlike FileStore it never writes: it does not run recovery, create directories or touch the
 * audit log. Each current() re-reads HEAD, so a long-lived reader sees revisions committed by
 * another process (for example `vcv approve`) on its next call. That is safe without recovery
 * because a revision file is written before HEAD names it and is never rewritten, and HEAD
 * itself is replaced by an atomic rename; leftovers of an interrupted commit are not listed in
 * HEAD and so are never read.
 */
export class FileStoreReader {
  private readonly dir: string;
  private cached?: { key: string; model: Model };
  /** storeFingerprint() at the last integrity check that passed. */
  private checked = "";

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(join(dir, "HEAD"))) throw new StoreError("NOT_INITIALIZED", `${dir} is not an initialized model store (run init first)`);
    this.current(); // fail at open, not on the first query, if HEAD or the current revision is unreadable
  }

  /** The committed revision HEAD names right now. */
  current(): Model {
    this.check();
    const head = readHeadFile(this.dir);
    // Cache by what is on disk, not by ID alone: the initial revision and legacy IDs (rev-1) are
    // not content-addressed, so two branches can hold different models under the same ID. The
    // key covers HEAD's whole line and the revision file's bytes, so a checkout always misses.
    const key = revisionCacheKey(this.dir, head);
    if (this.cached?.key !== key) {
      this.cached = { key, model: readRevisionFile(this.dir, head.revision, head.history) };
    }
    // Callers get their own copy, as with MemoryStore, so nothing can alter the cached revision.
    return structuredClone(this.cached.model);
  }

  revisions(): string[] {
    this.check();
    return [...readHeadFile(this.dir).history];
  }

  /**
   * Re-run the read-only integrity checks (inspectStore) whenever any store file changed, so a
   * long-lived reader refuses a checkout that a fresh open would refuse: conflicted, diverged
   * (even with HEAD unchanged) or corrupt. Never writes.
   */
  private check(): void {
    const fp = storeFingerprint(this.dir);
    if (fp === this.checked) return;
    const r = inspectStore(this.dir);
    switch (r.state) {
      case "ok":
        this.checked = fp;
        return;
      case "conflicted":
        throw conflictError(r.files);
      case "diverged":
        throw divergedError(r.foreign);
      case "invalid":
        throw new StoreError("CORRUPT", r.message);
      default:
        throw new StoreError("NOT_INITIALIZED", `${this.dir} is not an initialized model store`);
    }
  }
}

function readHeadFile(dir: string): Head {
  let text: string;
  try {
    text = readFileSync(join(dir, "HEAD"), "utf8");
  } catch {
    throw new StoreError("CORRUPT", "HEAD is unreadable");
  }
  if (hasConflictMarkers(text)) throw conflictError(["HEAD"]);
  let head: Head;
  try {
    head = JSON.parse(text) as Head;
  } catch {
    throw new StoreError("CORRUPT", "HEAD is unreadable");
  }
  if (head.format !== 1 || !Array.isArray(head.history) || head.history.at(-1) !== head.revision) {
    throw new StoreError("CORRUPT", "HEAD is not a valid format-1 head");
  }
  if (new Set(head.history).size !== head.history.length) throw new StoreError("CORRUPT", "HEAD lists a revision twice");
  return head;
}

// --- Git-aware integrity checks (ADR 0007) ---------------------------------------------

const CONFLICT_MARKER = /^(<{7}|>{7})(\s|$)/m;
const hasConflictMarkers = (text: string) => CONFLICT_MARKER.test(text);

/** Store files (relative paths) that contain Git conflict markers. */
export function conflictedFiles(dir: string): string[] {
  const out: string[] = [];
  const check = (rel: string) => {
    try {
      if (hasConflictMarkers(readFileSync(join(dir, rel), "utf8"))) out.push(rel);
    } catch {
      // unreadable files are reported by the regular checks
    }
  };
  if (existsSync(join(dir, "HEAD"))) check("HEAD");
  for (const sub of ["revisions", "changes"]) {
    if (!existsSync(join(dir, sub))) continue;
    for (const f of readdirSync(join(dir, sub)).sort()) if (!f.includes(".tmp-")) check(`${sub}/${f}`);
  }
  return out;
}

export type UnlistedRevision = {
  id: string;
  file: string;
  /** leftover: provably an interrupted commit of this store. foreign: anything else. */
  kind: "leftover" | "foreign";
  reason: string;
};

/**
 * Revision files present on disk that HEAD's history does not list, classified. Read-only.
 *
 * Conservative by design (ADR 0007 §3): recovery may move a "leftover" out of the way, so a
 * file is a leftover only if all of these hold, and is "foreign" (never moved) otherwise:
 *   1. it is the next child of HEAD: branch-safe digest verifies with HEAD as parent at
 *      seq = history length + 1 (legacy IDs: named nextRevision(HEAD));
 *   2. no change record says it was applied. The commit protocol writes the applied record only
 *      after HEAD names the revision, so an applied record is durable evidence that the revision
 *      was committed on some line of history, not interrupted;
 *   3. it is the only such candidate. One interrupted commit leaves at most one file, so two
 *      verified children (e.g. two branches merged with HEAD resolved to their common ancestor)
 *      mean real branch revisions.
 */
export function unlistedRevisions(dir: string, head: { revision: string; history: readonly string[] }): UnlistedRevision[] {
  const committed = new Set(head.history);
  if (!existsSync(join(dir, "revisions"))) return [];
  const seq = head.history.length + 1;
  const applied = appliedRevisions(dir);
  const found: UnlistedRevision[] = [];
  for (const file of readdirSync(join(dir, "revisions")).sort()) {
    if (file.includes(".tmp-")) continue;
    const id = file.replace(/\.yaml$/, "");
    if (committed.has(id)) continue;
    if (parseRevisionId(id).scheme === "legacy") {
      // Pre-M2 stores minted sequential IDs, so only the name can be checked.
      found.push(
        id === nextRevision(head.revision)
          ? { id, file, kind: "leftover", reason: `named as the next sequential revision after ${head.revision}` }
          : { id, file, kind: "foreign", reason: `not in HEAD's history and not the next revision after ${head.revision}` },
      );
      continue;
    }
    let model: Model | undefined;
    try {
      model = loadModel(readFileSync(join(dir, "revisions", file), "utf8")).model;
    } catch {
      model = undefined;
    }
    if (model && model.project.modelRevision === id && isChildRevision(id, model, head.revision, seq)) {
      found.push({ id, file, kind: "leftover", reason: `content digest matches a child of ${head.revision}` });
    } else {
      found.push({ id, file, kind: "foreign", reason: model ? `not a child of HEAD revision ${head.revision}` : "unreadable revision file" });
    }
  }
  const candidates = found.filter((u) => u.kind === "leftover");
  for (const u of candidates) {
    const by = applied.get(u.id);
    if (by) {
      u.kind = "foreign";
      u.reason = `change ${by} records it as applied, so it was committed on another line of history`;
    } else if (candidates.length > 1) {
      u.kind = "foreign";
      u.reason = `${candidates.length} unlisted children of ${head.revision}; an interrupted commit leaves at most one, so these are branch revisions`;
    }
  }
  return found;
}

/** Revision ID → change ID, for every readable "applied" change record. Read-only. */
function appliedRevisions(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(join(dir, "changes"))) return out;
  for (const f of readdirSync(join(dir, "changes")).sort()) {
    if (f.includes(".tmp-") || !f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, "changes", f), "utf8")) as Partial<ChangeRecord>;
      if (rec.status === "applied" && typeof rec.resultingRevision === "string") out.set(rec.resultingRevision, rec.changeId ?? f.replace(/\.json$/, ""));
    } catch {
      // unreadable records are reported by the regular checks
    }
  }
  return out;
}

function conflictError(files: string[]): StoreError {
  return new StoreError("CONFLICTED", `unresolved Git merge conflict in ${files.join(", ")}; VCV does not merge model histories, resolve the merge (or check out one side) first`);
}

function divergedError(foreign: UnlistedRevision[]): StoreError {
  return new StoreError(
    "DIVERGED",
    `revisions ${foreign.map((f) => f.id).join(", ")} are not in HEAD's history (${foreign[0]!.reason}); they probably come from another branch. ` +
      "VCV will not drop or merge them automatically: keep one line of history and remove the other's revision files, or restore the matching HEAD",
  );
}

export type StoreInspection =
  | { state: "absent"; dir: string }
  | { state: "uninitialized"; dir: string }
  | { state: "conflicted"; dir: string; files: string[] }
  | { state: "invalid"; dir: string; message: string }
  | { state: "diverged"; dir: string; revision: string; history: string[]; foreign: UnlistedRevision[]; leftovers: UnlistedRevision[] }
  | { state: "ok"; dir: string; revision: string; history: string[]; leftovers: UnlistedRevision[] };

/**
 * Describe a store directory without changing anything: no recovery, no directory creation.
 * Used by project loading to decide whether a checkout's model can be served, and why not.
 */
export function inspectStore(dir: string): StoreInspection {
  if (!existsSync(dir)) return { state: "absent", dir };
  if (!existsSync(join(dir, "HEAD"))) return { state: "uninitialized", dir };
  const files = conflictedFiles(dir);
  if (files.length) return { state: "conflicted", dir, files };
  let head: Head;
  try {
    head = readHeadFile(dir);
    for (const rev of head.history) readRevisionFile(dir, rev, head.history);
  } catch (e) {
    return { state: "invalid", dir, message: e instanceof Error ? e.message : String(e) };
  }
  const unlisted = unlistedRevisions(dir, head);
  const foreign = unlisted.filter((u) => u.kind === "foreign");
  const leftovers = unlisted.filter((u) => u.kind === "leftover");
  const base = { dir, revision: head.revision, history: [...head.history], leftovers };
  return foreign.length ? { state: "diverged", ...base, foreign } : { state: "ok", ...base };
}

/** SHA-256 of a revision file's bytes, or null if it cannot be read. Used to tell same-ID revisions apart. */
export function revisionFileDigest(dir: string, rev: string): string | null {
  if (persistedIdProblem(rev)) return null;
  try {
    return createHash("sha256").update(readFileSync(join(dir, "revisions", `${rev}.yaml`))).digest("hex");
  } catch {
    return null;
  }
}

/**
 * The model HEAD names, read and verified like any committed revision, without the store-wide
 * integrity checks. For status reporting of a store that may be diverged; never for serving.
 */
export function readHeadRevision(dir: string): Model {
  const head = readHeadFile(dir);
  return readRevisionFile(dir, head.revision, head.history);
}

/**
 * Cheap identity of the store's shared files: HEAD's bytes, the current revision file's bytes,
 * and name, size and mtime of every file in revisions/ and changes/. Any Git checkout, merge or
 * edit that could change what the checks decide changes this value. Read-only.
 */
export function storeFingerprint(dir: string): string {
  const h = createHash("sha256");
  let headText = "";
  try {
    headText = readFileSync(join(dir, "HEAD"), "utf8");
  } catch {
    headText = "\0no-head";
  }
  h.update(headText).update("\0");
  try {
    const rev = (JSON.parse(headText) as { revision?: unknown }).revision;
    if (typeof rev === "string" && !persistedIdProblem(rev)) h.update(readFileSync(join(dir, "revisions", `${rev}.yaml`)));
  } catch {
    h.update("\0unreadable");
  }
  for (const sub of ["revisions", "changes"]) {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, sub)).sort();
    } catch {
      names = [];
    }
    for (const n of names) {
      try {
        const st = statSync(join(dir, sub, n));
        h.update(`\0${sub}/${n}:${st.size}:${st.mtimeMs}`);
      } catch {
        h.update(`\0${sub}/${n}:gone`);
      }
    }
  }
  return h.digest("hex");
}

function revisionCacheKey(dir: string, head: Head): string {
  if (persistedIdProblem(head.revision)) return "invalid"; // readRevisionFile reports it
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(dir, "revisions", `${head.revision}.yaml`));
  } catch {
    return `missing\0${head.history.join("\0")}`; // readRevisionFile reports it
  }
  return `${createHash("sha256").update(bytes).digest("hex")}\0${head.history.join("\0")}`;
}

const sameRecord = (a: ChangeRecord | null, b: ChangeRecord | null) => (a === null || b === null ? a === b : canonicalJson(a) === canonicalJson(b));

const sameLine = (a: Head, b: Head) => a.revision === b.revision && a.history.length === b.history.length && a.history.every((r, i) => b.history[i] === r);

/**
 * Read a committed revision. With `history`, also check that the file still is the revision its
 * ID names: project.modelRevision matches, and for branch-safe IDs past the first entry the
 * content digest verifies against the previous entry as parent at that position. A failed check
 * is CORRUPT and nothing is rewritten (ADR 0007 §3).
 */
function readRevisionFile(dir: string, rev: string, history?: readonly string[]): Model {
  if (persistedIdProblem(rev)) throw new StoreError("CORRUPT", `HEAD lists an invalid revision ID "${rev}"`);
  let text: string;
  try {
    text = readFileSync(join(dir, "revisions", `${rev}.yaml`), "utf8");
  } catch {
    throw new StoreError("CORRUPT", `committed revision ${rev} is missing`);
  }
  if (hasConflictMarkers(text)) throw conflictError([`revisions/${rev}.yaml`]);
  const r = loadModel(text);
  if (!r.model) throw new StoreError("CORRUPT", `committed revision ${rev} is unreadable: ${r.diagnostics.map((d) => d.message).join("; ")}`);
  if (history) {
    if (r.model.project.modelRevision !== rev) {
      throw new StoreError("CORRUPT", `revisions/${rev}.yaml says it is ${r.model.project.modelRevision}`);
    }
    const i = history.indexOf(rev);
    if (i > 0 && parseRevisionId(rev).scheme === "branch-safe" && !isChildRevision(rev, r.model, history[i - 1]!, i + 1)) {
      throw new StoreError(
        "CORRUPT",
        `revisions/${rev}.yaml does not match its ID: its content digest does not verify as revision ${i + 1} after ${history[i - 1]} (edited after commit, or listed out of place in HEAD)`,
      );
    }
  }
  return r.model;
}

/** Write via temp file, fsync, rename, then fsync the directory where the OS allows it. */
function durableWrite(path: string, text: string, hook?: (phase: "write" | "rename") => void) {
  const tmp = `${path}.tmp-${process.pid}`;
  hook?.("write");
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  hook?.("rename");
  renameSync(tmp, path);
  try {
    const dfd = openSync(join(path, ".."), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Directory fsync is unsupported on some platforms (e.g. Windows); rename is still atomic.
  }
}
