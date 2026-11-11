// A bounded identity of working-tree files (review of PR #20).
//
// Handoffs and implementation reports are observations of a dirty checkout as much as of commits:
// the bound source files and the files changed since a base commit. `worktreeState` names exactly
// which bytes were seen, so a read surface can recheck them before it answers (STATE_CHANGED on any
// difference) and a stored report can say which dirty source state it describes. The same paths
// with the same bytes give the same digest.
//
// Safe and bounded: paths are repository-relative and never followed through a symlink (a symlink
// is identified by its target text, a directory or other non-file by its kind); files are opened
// O_NOFOLLOW|O_NONBLOCK and streamed in chunks; past the per-file or total byte budget, or the file
// count, a file is identified by its size and modification time instead of its bytes, and the state
// says so (`complete: false`). This is observation integrity, not a claim about what the code does.
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "@vcv/core";
import { pathProblem } from "./locator.ts";

export const WORKTREE_LIMITS = { files: 5000, fileBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 } as const;
const CHUNK = 1024 * 1024;

export type WorktreeState = {
  /** sha256 over the canonical [path, identity] pairs, sorted by path. */
  digest: string;
  files: number;
  /** False when some file was identified by size and mtime only (budget exhausted). */
  complete: boolean;
};

export function worktreeState(root: string, paths: Iterable<string>): WorktreeState {
  const sorted = [...new Set(paths)].sort();
  let budget: number = WORKTREE_LIMITS.totalBytes;
  let complete = true;
  const pairs = sorted.map((p, i) => {
    const id = identity(root, p, i < WORKTREE_LIMITS.files ? budget : 0);
    if (id.bytes) budget -= id.bytes;
    if (id.partial) complete = false;
    return [p, id.id];
  });
  return { digest: createHash("sha256").update(canonicalJson(pairs)).digest("hex"), files: sorted.length, complete };
}

function identity(root: string, rel: string, budget: number): { id: string; bytes?: number; partial?: boolean } {
  if (pathProblem(rel)) return { id: "unsafe-path" };
  const segments = rel.split("/");
  let abs = root;
  for (let i = 0; i < segments.length; i++) {
    abs = join(abs, segments[i]!);
    let st;
    try {
      st = lstatSync(abs, { bigint: true });
    } catch {
      return { id: "absent" };
    }
    if (st.isSymbolicLink()) {
      if (i < segments.length - 1) return { id: "via-symlink" };
      try {
        return { id: `symlink:${createHash("sha256").update(readlinkSync(abs)).digest("hex")}` };
      } catch {
        return { id: "symlink:unreadable" };
      }
    }
    if (i < segments.length - 1) {
      if (!st.isDirectory()) return { id: "absent" };
      continue;
    }
    if (st.isDirectory()) return { id: "directory" };
    if (!st.isFile()) return { id: "not-a-file" };
    const stat = `stat:${st.size}:${st.mtimeNs}:${st.ino}`;
    if (st.size > BigInt(Math.min(budget, WORKTREE_LIMITS.fileBytes))) return { id: stat, partial: true };
    return hashFile(abs) ?? { id: "unreadable" };
  }
  return { id: "absent" };
}

function hashFile(abs: string): { id: string; bytes: number } | null {
  let fd: number;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return { id: "not-a-file", bytes: 0 };
    const h = createHash("sha256");
    const buf = Buffer.alloc(CHUNK);
    let total = 0;
    for (let n; (n = readSync(fd, buf, 0, CHUNK, null)) > 0; ) {
      total += n;
      // Grew past the per-file budget while being read: identify it as changing, not by a prefix.
      if (total > WORKTREE_LIMITS.fileBytes) return { id: `growing:${total}`, bytes: total };
      h.update(buf.subarray(0, n));
    }
    return { id: `sha256:${h.digest("hex")}`, bytes: total };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
