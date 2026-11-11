// Read-only Git observation (ADR 0007). Everything here describes the checkout as it is now;
// none of it is canonical intent and none of it is written into .vcv/.
//
// Only read commands are run, with GIT_OPTIONAL_LOCKS=0 so `git status` does not refresh and
// rewrite the index. VCV never fetches, pulls, checks out or merges.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export type GitObservation = {
  /** Absolute path of the working tree. Local to this machine; never persisted. */
  root: string;
  /** Commit HEAD points at, or null in a repository with no commits yet. */
  commit: string | null;
  /** Checked-out branch, or null when HEAD is detached (or unborn without a name). */
  branch: string | null;
  detached: boolean;
  /** True when the working tree differs from HEAD (tracked changes or untracked files). */
  dirty: boolean;
  /** Changed or untracked paths under the store directory, repository-relative, sorted. */
  storeChanges: string[];
  /** A Git operation in progress that leaves files half-merged, if any. */
  operation: GitOperation | null;
};

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
  } catch {
    return null;
  }
}

/** The working-tree root containing `path`, or null if it is not inside a Git checkout (or Git is missing). */
export function findWorkTreeRoot(path: string): string | null {
  const out = git(resolve(path), ["rev-parse", "--show-toplevel"]);
  return out ? resolve(out.trim()) : null;
}

/**
 * Observe a working tree. `storeRelPath` is the store directory relative to the root (".vcv").
 */
export function observeGit(root: string, storeRelPath = ".vcv"): GitObservation {
  const commit = git(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;
  const symbolic = git(root, ["symbolic-ref", "-q", "--short", "HEAD"])?.trim() || null;
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "";
  const entries = parsePorcelainZ(status);
  const prefix = storeRelPath.replace(/\/+$/, "") + "/";
  return {
    root,
    commit,
    branch: symbolic,
    detached: symbolic === null,
    dirty: entries.length > 0,
    storeChanges: entries.filter((p) => p.startsWith(prefix)).sort(),
    operation: gitOperation(root),
  };
}

/** Paths from `git status --porcelain=v1 -z`; renames contribute both names. */
function parsePorcelainZ(text: string): string[] {
  const parts = text.split("\0").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    out.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") out.push(parts[++i]!); // the original path follows
  }
  return out;
}

function gitOperation(root: string): GitOperation | null {
  const marker = (name: string) => {
    const p = git(root, ["rev-parse", "--git-path", name])?.trim();
    if (!p) return false;
    return existsSync(isAbsolute(p) ? p : join(root, p));
  };
  if (marker("MERGE_HEAD")) return "merge";
  if (marker("rebase-merge") || marker("rebase-apply")) return "rebase";
  if (marker("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (marker("REVERT_HEAD")) return "revert";
  return null;
}
