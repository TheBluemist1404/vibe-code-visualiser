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
} from "node:fs";
import { join } from "node:path";
import { dumpModel, persistedIdProblem } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import type { AuditEvent, ChangeRecord } from "../engine.ts";
import { sha256Hex } from "../digest.ts";
import { assertCommittable } from "./model-store.ts";
import type { ChangeGuard, ModelStore, StoreSnapshot } from "./model-store.ts";
import {
  STORE_FILE_LIMITS,
  StoreError,
  assertPersistedId,
  conflictError,
  divergedError,
  durableWrite,
  listStoreDir,
  readHeadFile,
  readRevisionFile,
  readStoreFile,
  sameRecord,
} from "./files.ts";
import type { Head } from "./files.ts";
import {
  conflictedFiles,
  inspectStore,
  storeFingerprint,
  unlistedRevisions,
  unreadableChangeRecords,
} from "./inspect.ts";

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
    if (!existsSync(join(dir, "HEAD")))
      throw new StoreError("NOT_INITIALIZED", `${dir} is not an initialized model store (run init first)`);
    this.head = this.readHead();
    this.recovery = this.recover();
    this.validated = storeFingerprint(dir);
  }

  static init(dir: string, initial: Model, opts: FileStoreOptions = {}): FileStore {
    if (existsSync(join(dir, "HEAD")))
      throw new StoreError("ALREADY_INITIALIZED", `${dir} already holds a model store`);
    const rev = initial.project.modelRevision;
    assertPersistedId("revision", rev);
    for (const sub of ["revisions", "changes", "orphaned"]) mkdirSync(join(dir, sub), { recursive: true });
    durableWrite(join(dir, "revisions", `${rev}.yaml`), dumpModel(initial));
    const head: Head = { format: 1, revision: rev, history: [rev] };
    durableWrite(join(dir, "HEAD"), `${JSON.stringify(head, null, 2)}\n`); // initialized only once HEAD exists
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
    return {
      model: readRevisionFile(this.dir, this.head.revision, this.head.history),
      history: [...this.head.history],
      token: this.validated,
    };
  }

  commit(model: Model, record: ChangeRecord, guard?: string | ChangeGuard): void {
    const g = typeof guard === "string" ? { token: guard } : guard;
    const token = g?.token;
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
    // Change identity: the record this commit replaces must be exactly the one the decision was
    // made on (none for a new proposal, the pending record for an approval).
    if (g && "previous" in g && !sameRecord(this.recordOnDisk(record.changeId), g.previous)) {
      throw new StoreError(
        "STORE_CHANGED",
        `change ${record.changeId} on disk is not the record this change was validated with; nothing was written`,
      );
    }
    const rev = model.project.modelRevision;
    const next: Head = { format: 1, revision: rev, history: [...this.head.history, rev], lastCommit: record };

    this.write("revision", join(this.dir, "revisions", `${rev}.yaml`), dumpModel(model));
    this.write("head", join(this.dir, "HEAD"), `${JSON.stringify(next, null, 2)}\n`);
    this.head = next; // committed: from here on the revision exists
    this.write("change", this.changePath(record.changeId), `${JSON.stringify(record, null, 2)}\n`);
    this.validated = storeFingerprint(this.dir); // our own writes are known-good
  }

  getChange(id: string): ChangeRecord | undefined {
    this.changePath(id); // validates the ID
    const f = readStoreFile(this.dir, `changes/${id}.json`, STORE_FILE_LIMITS.change);
    if (f.kind === "absent") return undefined;
    if (f.kind === "unsafe") throw new StoreError("CORRUPT", `change record ${id} is unreadable: ${f.problem}`);
    try {
      return JSON.parse(f.text) as ChangeRecord;
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
      const onDisk = this.recordOnDisk(record.changeId);
      if (before !== this.validated || guard.token !== before || !sameRecord(onDisk, guard.previous)) {
        throw new StoreError(
          "STORE_CHANGED",
          `change ${record.changeId} or other store files changed on disk since validation (for example a Git checkout); nothing was written. Re-read and retry.`,
        );
      }
    }
    durableWrite(path, `${JSON.stringify(record, null, 2)}\n`);
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
      appendFileSync(fd, `${prefix}${JSON.stringify(event)}\n`);
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
    const report: RecoveryReport = {
      removedTempFiles: [],
      orphanedRevisions: [],
      orphanedChangeRecords: [],
      repairedChangeRecords: [],
    };
    mkdirSync(join(this.dir, "orphaned"), { recursive: true });
    mkdirSync(join(this.dir, "changes"), { recursive: true });

    // 1. Temp files are never committed content.
    for (const sub of ["", "revisions", "changes"]) {
      for (const f of sub ? listStoreDir(this.dir, sub) : readdirSync(this.dir)) {
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
    // Leftover classification relies on reading every applied record, so an unreadable record
    // is a refusal too, raised before anything is moved.
    const badRecord = unreadableChangeRecords(this.dir)[0];
    if (badRecord) throw new StoreError("CORRUPT", badRecord);
    for (const u of unlisted) {
      renameSync(join(this.dir, "revisions", u.file), join(this.dir, "orphaned", `revision.${u.file}`));
      report.orphanedRevisions.push(u.id);
    }

    // 3. An "applied" record must point at a committed revision.
    for (const f of listStoreDir(this.dir, "changes")) {
      if (!f.endsWith(".json") || persistedIdProblem(f.replace(/\.json$/, ""))) continue;
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
        durableWrite(this.changePath(last.changeId), `${JSON.stringify(last, null, 2)}\n`);
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

  private recordOnDisk(id: string): ChangeRecord | null {
    this.changePath(id);
    const f = readStoreFile(this.dir, `changes/${id}.json`, STORE_FILE_LIMITS.change);
    if (f.kind === "absent") return null;
    try {
      if (f.kind === "unsafe") throw new Error(f.problem);
      return JSON.parse(f.text) as ChangeRecord;
    } catch {
      return { changeId: "\0unreadable" } as ChangeRecord;
    }
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
    if (!existsSync(join(dir, "HEAD")))
      throw new StoreError("NOT_INITIALIZED", `${dir} is not an initialized model store (run init first)`);
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

  /** A committed revision of the line HEAD names (verified like every revision read), or undefined. */
  revision(rev: string): Model | undefined {
    this.check();
    const head = readHeadFile(this.dir);
    return head.history.includes(rev) ? readRevisionFile(this.dir, rev, head.history) : undefined;
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

function revisionCacheKey(dir: string, head: Head): string {
  if (persistedIdProblem(head.revision)) return "invalid"; // readRevisionFile reports it
  const f = readStoreFile(dir, `revisions/${head.revision}.yaml`, STORE_FILE_LIMITS.revision);
  if (f.kind !== "file") return `missing\0${head.history.join("\0")}`; // readRevisionFile reports it
  const bytes = f.bytes;
  return `${sha256Hex(bytes)}\0${head.history.join("\0")}`;
}

const sameLine = (a: Head, b: Head) =>
  a.revision === b.revision && a.history.length === b.history.length && a.history.every((r, i) => b.history[i] === r);
