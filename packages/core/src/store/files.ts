// Safe reads and durable writes of store files, and the store's error type.
//
// A checkout is untrusted input: `.vcv/` may hold a symlink to a file outside the repository, a
// FIFO that would block a read, or a huge file. Every read of HEAD, a revision or a change record
// goes through readStoreFile: regular files only, never through a symlink (lstat, then O_NOFOLLOW
// and a re-check on the open descriptor), size-bounded. The `revisions/` and `changes/`
// directories themselves must be plain directories. Anything else is reported, never followed.
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { loadModel, persistedIdProblem } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import type { ChangeRecord } from "../engine.ts";
import { canonicalJson } from "../digest.ts";
import { isChildRevision, parseRevisionId } from "../revisions.ts";
import { OPEN_READ_NOFOLLOW, readUpTo } from "../fs.ts";
import type { UnlistedRevision } from "./inspect.ts";

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

//
// A checkout is untrusted input: `.vcv/` may hold a symlink to a file outside the repository, a
// FIFO that would block a read, or a huge file. Every read of HEAD, a revision or a change record
// goes through readStoreFile: regular files only, never through a symlink (lstat, then O_NOFOLLOW
// and a re-check on the open descriptor), size-bounded. The `revisions/` and `changes/`
// directories themselves must be plain directories. Anything else is reported, never followed.

/** Size bounds for store files (bytes). Change records hold at most one bounded proposal plus diagnostics. */
export const STORE_FILE_LIMITS = { head: 4 * 1024 * 1024, revision: 8 * 1024 * 1024, change: 1024 * 1024 } as const;

export type StoreFileRead =
  | { kind: "file"; bytes: Buffer; text: string }
  | { kind: "absent" }
  | { kind: "unsafe"; problem: string };

export function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw e;
  }
}

/** Why `sub` (e.g. "changes") is not a plain directory of the store, or undefined (absent is fine). */
function subdirProblem(dir: string, sub: string): string | undefined {
  const st = lstatOrNull(join(dir, sub));
  if (!st) return undefined;
  if (st.isSymbolicLink()) return `${sub}/ is a symlink, which is never followed`;
  if (!st.isDirectory()) return `${sub}/ is not a directory`;
  return undefined;
}

/** Entry names of a store subdirectory, sorted; [] if absent. CORRUPT if it is not a plain directory. */
export function listStoreDir(dir: string, sub: string): string[] {
  const problem = subdirProblem(dir, sub);
  if (problem) throw new StoreError("CORRUPT", problem);
  if (!existsSync(join(dir, sub))) return [];
  return readdirSync(join(dir, sub)).sort();
}

/**
 * Read one store file (`rel` is store-relative, e.g. "changes/x.json"): a regular file of at most
 * `max` bytes, opened without following symlinks and checked again on the descriptor, so a swap
 * after the lstat cannot redirect the read. Never blocks on a FIFO or device. Read-only.
 */
export function readStoreFile(dir: string, rel: string, max: number): StoreFileRead {
  const slash = rel.indexOf("/");
  if (slash > 0) {
    const problem = subdirProblem(dir, rel.slice(0, slash));
    if (problem) return { kind: "unsafe", problem };
  }
  const p = join(dir, rel);
  const st = lstatOrNull(p);
  if (!st) return { kind: "absent" };
  if (st.isSymbolicLink()) return { kind: "unsafe", problem: `${rel} is a symlink, which is never followed` };
  if (!st.isFile()) return { kind: "unsafe", problem: `${rel} is not a regular file` };
  if (st.size > max) return { kind: "unsafe", problem: `${rel} is larger than ${max} bytes` };
  let fd: number;
  try {
    fd = openSync(p, OPEN_READ_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    if (code === "ELOOP") return { kind: "unsafe", problem: `${rel} is a symlink, which is never followed` };
    return { kind: "unsafe", problem: `${rel} cannot be opened (${code})` };
  }
  try {
    if (!fstatSync(fd).isFile()) return { kind: "unsafe", problem: `${rel} is not a regular file` };
    const read = readUpTo(fd, max);
    if (read.length > max) return { kind: "unsafe", problem: `${rel} is larger than ${max} bytes` };
    const bytes = Buffer.from(read);
    return { kind: "file", bytes, text: bytes.toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/** One store file's text, or a CORRUPT error naming the problem. */
function readStoreText(dir: string, rel: string, max: number, missing: string): string {
  const f = readStoreFile(dir, rel, max);
  if (f.kind === "absent") throw new StoreError("CORRUPT", missing);
  if (f.kind === "unsafe") throw new StoreError("CORRUPT", f.problem);
  return f.text;
}

export function assertPersistedId(kind: string, value: string): void {
  const problem = persistedIdProblem(value);
  if (problem) throw new StoreError("INVALID_ID", `${kind} "${value}" ${problem}`);
}

export type Head = { format: 1; revision: string; history: string[]; lastCommit?: ChangeRecord };

export function readHeadFile(dir: string): Head {
  const text = readStoreText(dir, "HEAD", STORE_FILE_LIMITS.head, "HEAD is unreadable");
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
  if (new Set(head.history).size !== head.history.length)
    throw new StoreError("CORRUPT", "HEAD lists a revision twice");
  return head;
}

const CONFLICT_MARKER = /^(<{7}|>{7})(\s|$)/m;
export const hasConflictMarkers = (text: string) => CONFLICT_MARKER.test(text);

export function conflictError(files: string[]): StoreError {
  return new StoreError(
    "CONFLICTED",
    `unresolved Git merge conflict in ${files.join(", ")}; VCV does not merge model histories, resolve the merge (or check out one side) first`,
  );
}

export function divergedError(foreign: UnlistedRevision[]): StoreError {
  return new StoreError(
    "DIVERGED",
    `revisions ${foreign.map((f) => f.id).join(", ")} are not in HEAD's history (${foreign[0]!.reason}); they probably come from another branch. ` +
      "VCV will not drop or merge them automatically: keep one line of history and remove the other's revision files, or restore the matching HEAD",
  );
}

export const sameRecord = (a: ChangeRecord | null, b: ChangeRecord | null) =>
  a === null || b === null ? a === b : canonicalJson(a) === canonicalJson(b);

/**
 * Read a committed revision. With `history`, also check that the file still is the revision its
 * ID names: project.modelRevision matches, and for branch-safe IDs past the first entry the
 * content digest verifies against the previous entry as parent at that position. A failed check
 * is CORRUPT and nothing is rewritten (ADR 0007 §3).
 */
export function readRevisionFile(dir: string, rev: string, history?: readonly string[]): Model {
  if (persistedIdProblem(rev)) throw new StoreError("CORRUPT", `HEAD lists an invalid revision ID "${rev}"`);
  const text = readStoreText(
    dir,
    `revisions/${rev}.yaml`,
    STORE_FILE_LIMITS.revision,
    `committed revision ${rev} is missing`,
  );
  if (hasConflictMarkers(text)) throw conflictError([`revisions/${rev}.yaml`]);
  const r = loadModel(text);
  if (!r.model)
    throw new StoreError(
      "CORRUPT",
      `committed revision ${rev} is unreadable: ${r.diagnostics.map((d) => d.message).join("; ")}`,
    );
  if (history) {
    if (r.model.project.modelRevision !== rev) {
      throw new StoreError("CORRUPT", `revisions/${rev}.yaml says it is ${r.model.project.modelRevision}`);
    }
    const i = history.indexOf(rev);
    if (
      i > 0 &&
      parseRevisionId(rev).scheme === "branch-safe" &&
      !isChildRevision(rev, r.model, history[i - 1]!, i + 1)
    ) {
      throw new StoreError(
        "CORRUPT",
        `revisions/${rev}.yaml does not match its ID: its content digest does not verify as revision ${i + 1} after ${history[i - 1]} (edited after commit, or listed out of place in HEAD)`,
      );
    }
  }
  return r.model;
}

/** Write via temp file, fsync, rename, then fsync the directory where the OS allows it. */
export function durableWrite(path: string, text: string, hook?: (phase: "write" | "rename") => void) {
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
