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
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { dumpModel, loadModel, persistedIdProblem } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import type { AuditEvent, ChangeRecord } from "./engine.ts";

export type StoreErrorCode = "INVALID_ID" | "CORRUPT" | "REVISION_EXISTS" | "NOT_INITIALIZED" | "ALREADY_INITIALIZED" | "BAD_COMMIT";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "StoreError";
  }
}

export interface ModelStore {
  current(): Model;
  revision(rev: string): Model | undefined;
  /** Committed revisions, oldest first. */
  revisions(): string[];
  /** Atomically make `model` the current revision, recording the applied change. */
  commit(model: Model, record: ChangeRecord): void;
  getChange(changeId: string): ChangeRecord | undefined;
  /** Persist a non-committing record state (pending, rejected). */
  putChange(record: ChangeRecord): void;
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
  commit(model: Model, record: ChangeRecord): void {
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
  putChange(record: ChangeRecord): void {
    assertPersistedId("change id", record.changeId);
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
  /** What recovery found and fixed when this store was opened. */
  readonly recovery: RecoveryReport;

  constructor(dir: string, opts: FileStoreOptions = {}) {
    this.dir = dir;
    this.opts = opts;
    if (!existsSync(join(dir, "HEAD"))) throw new StoreError("NOT_INITIALIZED", `${dir} is not an initialized model store (run init first)`);
    this.head = this.readHead();
    this.recovery = this.recover();
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

  current(): Model {
    return this.revision(this.head.revision)!;
  }

  revision(rev: string): Model | undefined {
    if (!this.head.history.includes(rev)) return undefined; // uncommitted files do not exist
    const p = join(this.dir, "revisions", `${rev}.yaml`);
    const r = loadModel(readFileSync(p, "utf8"));
    if (!r.model) throw new StoreError("CORRUPT", `committed revision ${rev} is unreadable: ${r.diagnostics.map((d) => d.message).join("; ")}`);
    return r.model;
  }

  revisions(): string[] {
    return [...this.head.history];
  }

  commit(model: Model, record: ChangeRecord): void {
    assertCommittable(model, record, this.head.history);
    const rev = model.project.modelRevision;
    const next: Head = { format: 1, revision: rev, history: [...this.head.history, rev], lastCommit: record };

    this.write("revision", join(this.dir, "revisions", `${rev}.yaml`), dumpModel(model));
    this.write("head", join(this.dir, "HEAD"), JSON.stringify(next, null, 2) + "\n");
    this.head = next; // committed: from here on the revision exists
    this.write("change", this.changePath(record.changeId), JSON.stringify(record, null, 2) + "\n");
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

  putChange(record: ChangeRecord): void {
    if (record.status === "applied") throw new StoreError("BAD_COMMIT", "applied records are written only by commit()");
    durableWrite(this.changePath(record.changeId), JSON.stringify(record, null, 2) + "\n");
  }

  appendAudit(event: AuditEvent): void {
    const fd = openSync(join(this.dir, "audit.jsonl"), "a");
    try {
      appendFileSync(fd, JSON.stringify(event) + "\n");
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

    // 2. Revision files HEAD does not list are leftovers of an interrupted commit.
    const committed = new Set(this.head.history);
    for (const f of readdirSync(join(this.dir, "revisions"))) {
      const rev = f.replace(/\.yaml$/, "");
      if (!committed.has(rev)) {
        renameSync(join(this.dir, "revisions", f), join(this.dir, "orphaned", `revision.${f}`));
        report.orphanedRevisions.push(rev);
      }
    }
    for (const rev of this.head.history) {
      if (!existsSync(join(this.dir, "revisions", `${rev}.yaml`))) {
        throw new StoreError("CORRUPT", `HEAD lists revision ${rev} but its file is missing`);
      }
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
    const last = this.head.lastCommit;
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
    let head: Head;
    try {
      head = JSON.parse(readFileSync(join(this.dir, "HEAD"), "utf8")) as Head;
    } catch {
      throw new StoreError("CORRUPT", "HEAD is unreadable");
    }
    if (head.format !== 1 || !Array.isArray(head.history) || head.history.at(-1) !== head.revision) {
      throw new StoreError("CORRUPT", "HEAD is not a valid format-1 head");
    }
    return head;
  }

  private changePath(id: string): string {
    assertPersistedId("change id", id);
    return join(this.dir, "changes", `${id}.json`);
  }

  private write(step: "revision" | "head" | "change", path: string, text: string) {
    durableWrite(path, text, (phase) => this.opts.beforeStep?.(`${step}.${phase}`));
  }
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
