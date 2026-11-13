// Git-aware, read-only inspection of a store directory (ADR 0007): conflict markers, revisions
// HEAD does not list, change records, and fingerprints of what was read.
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadModel, persistedIdProblem } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import type { ChangeRecord } from "../engine.ts";
import { nextRevision } from "../engine.ts";
import { sha256Hex } from "../digest.ts";
import { isChildRevision, parseRevisionId } from "../revisions.ts";
import {
  STORE_FILE_LIMITS,
  hasConflictMarkers,
  listStoreDir,
  lstatOrNull,
  readHeadFile,
  readRevisionFile,
  readStoreFile,
} from "./files.ts";
import type { Head } from "./files.ts";

/** Store files (relative paths) that contain Git conflict markers. */
export function conflictedFiles(dir: string): string[] {
  const out: string[] = [];
  const check = (rel: string, max: number) => {
    // Unsafe or unreadable files are reported by the regular checks, never followed here.
    const f = readStoreFile(dir, rel, max);
    if (f.kind === "file" && hasConflictMarkers(f.text)) out.push(rel);
  };
  check("HEAD", STORE_FILE_LIMITS.head);
  for (const sub of ["revisions", "changes"] as const) {
    let names: string[];
    try {
      names = listStoreDir(dir, sub);
    } catch {
      continue; // reported by the regular checks
    }
    for (const f of names)
      if (!f.includes(".tmp-"))
        check(`${sub}/${f}`, sub === "revisions" ? STORE_FILE_LIMITS.revision : STORE_FILE_LIMITS.change);
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
export function unlistedRevisions(
  dir: string,
  head: { revision: string; history: readonly string[] },
): UnlistedRevision[] {
  const committed = new Set(head.history);
  if (!existsSync(join(dir, "revisions"))) return [];
  const seq = head.history.length + 1;
  const applied = appliedRevisions(dir);
  const found: UnlistedRevision[] = [];
  for (const file of listStoreDir(dir, "revisions")) {
    if (file.includes(".tmp-")) continue;
    const id = file.replace(/\.yaml$/, "");
    if (committed.has(id)) continue;
    if (parseRevisionId(id).scheme === "legacy") {
      // Pre-M2 stores minted sequential IDs, so only the name can be checked.
      found.push(
        id === nextRevision(head.revision)
          ? { id, file, kind: "leftover", reason: `named as the next sequential revision after ${head.revision}` }
          : {
              id,
              file,
              kind: "foreign",
              reason: `not in HEAD's history and not the next revision after ${head.revision}`,
            },
      );
      continue;
    }
    let model: Model | undefined;
    try {
      const f = readStoreFile(dir, `revisions/${file}`, STORE_FILE_LIMITS.revision);
      model = f.kind === "file" ? loadModel(f.text).model : undefined;
    } catch {
      model = undefined;
    }
    if (model && model.project.modelRevision === id && isChildRevision(id, model, head.revision, seq)) {
      found.push({ id, file, kind: "leftover", reason: `content digest matches a child of ${head.revision}` });
    } else {
      found.push({
        id,
        file,
        kind: "foreign",
        reason: model ? `not a child of HEAD revision ${head.revision}` : "unreadable revision file",
      });
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
/** One message per `changes/*.json` file that is not a readable record for its own change ID. */
/** One file under changes/, read without writing anything (M3.1 proposal listings). */
export type ChangeRecordEntry = { changeId: string; record?: ChangeRecord; problem?: string };

/**
 * The one reader of `changes/*.json` (inspection, recovery and listings all use it): each file
 * through readStoreFile (regular, no symlink, at most STORE_FILE_LIMITS.change bytes), then
 * parsed. An entry is unreadable when it is unsafe, not JSON, or names another change ID; such an
 * entry makes the store invalid (recovery relies on reading every applied record, ADR 0007), so
 * status, reader, writer and listings agree. Throws CORRUPT when changes/ is not a plain directory.
 */
function readChangeRecordFiles(dir: string): (ChangeRecordEntry & { file: string; unreadable: boolean })[] {
  const out: (ChangeRecordEntry & { file: string; unreadable: boolean })[] = [];
  for (const file of listStoreDir(dir, "changes")) {
    if (file.includes(".tmp-") || !file.endsWith(".json")) continue;
    const changeId = file.replace(/\.json$/, "");
    const f = readStoreFile(dir, `changes/${file}`, STORE_FILE_LIMITS.change);
    if (f.kind !== "file") {
      out.push({
        changeId,
        file,
        unreadable: true,
        problem: f.kind === "unsafe" ? f.problem : `changes/${file} disappeared while reading`,
      });
      continue;
    }
    let rec: unknown;
    try {
      rec = JSON.parse(f.text);
    } catch {
      out.push({ changeId, file, unreadable: true, problem: `changes/${file} is not valid JSON` });
      continue;
    }
    if (typeof rec !== "object" || rec === null || (rec as Partial<ChangeRecord>).changeId !== changeId) {
      out.push({
        changeId,
        file,
        unreadable: true,
        problem: `changes/${file} does not hold the record for ${changeId}`,
      });
      continue;
    }
    out.push({ changeId, file, unreadable: false, record: rec as ChangeRecord });
  }
  return out;
}

/**
 * Every change record file in a store directory, in ID order, read-only, through the same safe
 * reader as inspection. Unreadable files are listed with a problem (inspection reports the store
 * invalid for them); files whose name is not a persisted ID are skipped. The record content is not
 * otherwise trusted: callers derive state from it, never authority. Throws CORRUPT when changes/
 * is a symlink or not a directory.
 */
export function listChangeRecords(dir: string): ChangeRecordEntry[] {
  return readChangeRecordFiles(dir)
    .filter((e) => !persistedIdProblem(e.changeId))
    .map(({ changeId, record, problem }) => (record ? { changeId, record } : { changeId, problem: problem! }));
}

/** One message per `changes/*.json` file that is not a readable record for its own change ID. */
export function unreadableChangeRecords(dir: string): string[] {
  let entries;
  try {
    entries = readChangeRecordFiles(dir);
  } catch (e) {
    return [`change records are unreadable: ${(e as Error).message}`];
  }
  return entries.filter((e) => e.unreadable).map((e) => `change record ${e.changeId} is unreadable (${e.problem})`);
}

/** Revision ID → change ID, for every readable "applied" change record. Read-only. */
function appliedRevisions(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let entries;
  try {
    entries = readChangeRecordFiles(dir);
  } catch {
    return out; // reported by unreadableChangeRecords(), which inspection and recovery both check
  }
  for (const e of entries) {
    const rec = e.record;
    if (rec?.status === "applied" && typeof rec.resultingRevision === "string")
      out.set(rec.resultingRevision, rec.changeId);
  }
  return out;
}

export type StoreInspection =
  | { state: "absent"; dir: string }
  | { state: "uninitialized"; dir: string }
  | { state: "conflicted"; dir: string; files: string[] }
  | { state: "invalid"; dir: string; message: string }
  | {
      state: "diverged";
      dir: string;
      revision: string;
      history: string[];
      foreign: UnlistedRevision[];
      leftovers: UnlistedRevision[];
    }
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
  // Same rule as the writer: a store with an unreadable change record is not healthy, so status,
  // reader and writer agree on it.
  const badRecord = unreadableChangeRecords(dir)[0];
  if (badRecord) return { state: "invalid", dir, message: badRecord };
  let unlisted: UnlistedRevision[];
  try {
    unlisted = unlistedRevisions(dir, head);
  } catch (e) {
    return { state: "invalid", dir, message: e instanceof Error ? e.message : String(e) };
  }
  const foreign = unlisted.filter((u) => u.kind === "foreign");
  const leftovers = unlisted.filter((u) => u.kind === "leftover");
  const base = { dir, revision: head.revision, history: [...head.history], leftovers };
  return foreign.length ? { state: "diverged", ...base, foreign } : { state: "ok", ...base };
}

/** SHA-256 of a revision file's bytes, or null if it cannot be read. Used to tell same-ID revisions apart. */
export function revisionFileDigest(dir: string, rev: string): string | null {
  if (persistedIdProblem(rev)) return null;
  const f = readStoreFile(dir, `revisions/${rev}.yaml`, STORE_FILE_LIMITS.revision);
  return f.kind === "file" ? sha256Hex(f.bytes) : null;
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
  const headFile = readStoreFile(dir, "HEAD", STORE_FILE_LIMITS.head);
  const headText =
    headFile.kind === "file" ? headFile.text : `\0${headFile.kind === "unsafe" ? headFile.problem : "no-head"}`;
  h.update(headText).update("\0");
  try {
    const rev = (JSON.parse(headText) as { revision?: unknown }).revision;
    const f =
      typeof rev === "string" && !persistedIdProblem(rev)
        ? readStoreFile(dir, `revisions/${rev}.yaml`, STORE_FILE_LIMITS.revision)
        : undefined;
    if (f?.kind === "file") h.update(f.bytes);
    else if (f) h.update(`\0${f.kind}`);
  } catch {
    h.update("\0unreadable");
  }
  for (const sub of ["revisions", "changes"]) {
    let names: string[] = [];
    try {
      names = listStoreDir(dir, sub);
    } catch (e) {
      h.update(`\0${sub}:${(e as Error).message}`);
    }
    for (const n of names) {
      // lstat: a symlink is fingerprinted as itself, never followed.
      const st = lstatOrNull(join(dir, sub, n));
      h.update(
        st
          ? `\0${sub}/${n}:${st.isFile() ? "f" : st.isSymbolicLink() ? "l" : "o"}:${st.size}:${st.mtimeMs}`
          : `\0${sub}/${n}:gone`,
      );
    }
  }
  return h.digest("hex");
}
