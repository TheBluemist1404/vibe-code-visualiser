// Read-only Git observation (ADR 0007). Everything here describes the checkout as it is now;
// none of it is canonical intent and none of it is written into .vcv/.
//
// Only read commands are run, with GIT_OPTIONAL_LOCKS=0 so `git status` does not refresh and
// rewrite the index. VCV never fetches, pulls, checks out or merges.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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

/**
 * Every read runs with the checkout treated as data (M4.4 review): the checkout's own
 * configuration must not make Git execute anything. Repository-local config can name commands
 * (core.fsmonitor, hooks such as post-index-change, external diff drivers, clean/smudge filter
 * drivers selected by .gitattributes); these options switch each of them off for this process.
 * Attributes are read from the empty tree (GIT_ATTR_SOURCE, Git 2.40+), so no filter or diff
 * driver applies, whatever .gitattributes the checkout carries.
 */
const SAFE_OPTIONS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c",
  "core.untrackedCache=false",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
  "--no-pager",
];
const EMPTY_TREE = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const;
const objectFormat = new Map<string, "sha1" | "sha256">();
function safeEnv(cwd: string): NodeJS.ProcessEnv {
  let format = objectFormat.get(cwd);
  if (!format) {
    try {
      const out = execFileSync("git", ["-C", cwd, ...SAFE_OPTIONS, "rev-parse", "--show-object-format"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: baseEnv(),
      }).trim();
      format = out === "sha256" ? "sha256" : "sha1";
    } catch {
      format = "sha1";
    }
    objectFormat.set(cwd, format);
  }
  return { ...baseEnv(), GIT_ATTR_SOURCE: EMPTY_TREE[format] };
}
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_PAGER: "cat",
  };
  // Inherited variables that would point Git at another repository, config or attributes.
  for (const k of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_ATTR_SOURCE",
    "GIT_EXTERNAL_DIFF",
  ])
    delete env[k];
  return env;
}

/**
 * Thrown when Git cannot be run safely on this checkout: the configured filter and diff/merge
 * drivers could not be enumerated exactly (unreadable or oversized config, too many driver keys,
 * a failed or killed `git config`). Nothing that reads content runs then (M4.4 review round 2):
 * a missing override would let the checkout's own driver commands execute. Callers do not turn it
 * into "no changes" or "absent"; read surfaces report it as SOURCE_IDENTITY_UNAVAILABLE.
 */
export class GitRefusedError extends Error {
  readonly code = "GIT_REFUSED" as const;
  constructor(message: string) {
    super(message);
    this.name = "GitRefusedError";
  }
}

/** Bounds on the driver enumeration; past either, Git is refused rather than run without overrides. */
export const GIT_DRIVER_LIMITS = { keys: 1000, outputBytes: 256 * 1024 } as const;

/**
 * Per-repository overrides that empty every configured filter and diff/merge driver command.
 * $GIT_DIR/info/attributes can still select a driver (GIT_ATTR_SOURCE replaces only the in-tree
 * .gitattributes), and an empty command means "no driver". Reading config runs nothing.
 *
 * Fails closed: only `git config` exiting 1 with no output means "no driver keys". Every other
 * outcome other than a clean exit 0 within the bounds throws GitRefusedError.
 */
function driverOptions(cwd: string): string[] {
  // Read every time (config can change between reads in a long-lived process such as the MCP server).
  const r = spawnSync(
    "git",
    [
      "-C",
      cwd,
      ...SAFE_OPTIONS,
      "config",
      "--name-only",
      "--get-regexp",
      "^(filter|diff|merge)\\..+\\.(clean|smudge|process|command|textconv|driver)$",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: safeEnv(cwd),
      maxBuffer: GIT_DRIVER_LIMITS.outputBytes,
    },
  );
  if (r.error || r.signal)
    throw new GitRefusedError(
      `the checkout's Git driver configuration could not be read within ${GIT_DRIVER_LIMITS.outputBytes} bytes (${r.error?.message ?? r.signal})`,
    );
  if (r.status === 1 && r.stdout === "") return [];
  if (r.status !== 0)
    throw new GitRefusedError(
      `the checkout's Git driver configuration could not be read (git config exited ${r.status})`,
    );
  const keys = new Set(r.stdout.split("\n").filter(Boolean));
  if (keys.size === 0)
    throw new GitRefusedError(
      "the checkout's Git driver configuration could not be read (no keys in a successful listing)",
    );
  if (keys.size > GIT_DRIVER_LIMITS.keys)
    throw new GitRefusedError(
      `the checkout configures more than ${GIT_DRIVER_LIMITS.keys} Git filter or diff/merge driver keys`,
    );
  const out: string[] = [];
  for (const k of keys) {
    out.push("-c", `${k}=`);
    if (k.startsWith("filter.")) out.push("-c", `${k.slice(0, k.lastIndexOf("."))}.required=false`);
  }
  return out;
}

const isDirectory = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function git(cwd: string, args: string[]): string | null {
  // Not a directory (absent, or a file): Git cannot run there at all, so nothing can execute.
  if (!isDirectory(cwd)) return null;
  const drivers = driverOptions(cwd); // throws, outside the catch below, when Git is refused
  try {
    return execFileSync("git", ["-C", cwd, ...SAFE_OPTIONS, ...drivers, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: safeEnv(cwd),
      maxBuffer: 64 * 1024 * 1024,
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
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  // A status Git could not give is not a clean tree.
  const entries = status === null ? [] : parsePorcelainZ(status);
  const prefix = storeRelPath.replace(/\/+$/, "") + "/";
  return {
    root,
    commit,
    branch: symbolic,
    detached: symbolic === null,
    dirty: status === null || entries.length > 0,
    storeChanges: entries.filter((p) => p.startsWith(prefix)).sort(),
    operation: gitOperation(root),
  };
}

/** Paths from `git status --porcelain=v1 -z`; renames contribute both names. */
export function parsePorcelainZ(text: string): string[] {
  const parts = text.split("\0").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    out.push(entry.slice(3));
    // Renames and copies are followed by the original path, whether staged (X) or not (Y).
    if ("RC".includes(entry[0]!) || "RC".includes(entry[1]!)) out.push(parts[++i]!);
  }
  return out;
}

/** The commit HEAD points at, or null (no commits, or not a Git checkout). Cheaper than observeGit. */
export function headCommit(root: string): string | null {
  return git(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;
}

/**
 * How one repository-relative file compares with Git HEAD: unchanged, edited (staged or not),
 * or not tracked (new or ignored). "no-git" outside a working tree. Read-only.
 */
export function fileWorkingState(root: string, rel: string): "clean" | "modified" | "untracked" | "no-git" {
  if (!findWorkTreeRoot(root)) return "no-git";
  const tracked = git(root, ["ls-files", "-z", "--", rel]);
  // A failed Git read is never reported as clean (or as merely untracked).
  if (tracked === null) return "modified";
  if (tracked === "") return "untracked";
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", rel]);
  return status === "" ? "clean" : "modified";
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

/** The commit a ref (branch, tag, SHA, `origin/main`, `HEAD~1`) names, or null. Read-only; refs starting with "-" are refused. */
export function resolveCommit(root: string, ref: string): string | null {
  if (!ref || ref.startsWith("-") || /[\0\s]/.test(ref)) return null;
  return git(root, ["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`])?.trim() || null;
}

/**
 * The bytes of a repository-relative file at a commit, or null if it does not exist there or is
 * larger than `max` bytes. Read-only (`git cat-file`); never touches the working tree.
 */
export function fileAtCommit(root: string, commit: string, rel: string, max: number): Buffer | null {
  if (!/^[0-9a-f]{40,64}$/.test(commit) || rel.startsWith("-") || rel.includes("\0")) return null;
  const size = git(root, ["cat-file", "-s", `${commit}:${rel}`]);
  if (size === null || Number(size.trim()) > max) return null;
  if (!isDirectory(root)) return null;
  const drivers = driverOptions(root);
  try {
    return execFileSync("git", ["-C", root, ...SAFE_OPTIONS, ...drivers, "cat-file", "blob", `${commit}:${rel}`], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: max + 1,
      env: safeEnv(root),
    });
  } catch {
    return null;
  }
}

/**
 * What a commit has at a repository-relative path, without reading its bytes: absent (no entry),
 * a regular blob with its size, something else (tree, link, submodule), or null when Git could not
 * be asked. Read-only. Callers that need "absent" to mean absent use this before fileAtCommit, whose
 * null also covers oversized and unreadable blobs.
 */
export function entryAtCommit(
  root: string,
  commit: string,
  rel: string,
): { kind: "absent" } | { kind: "blob"; size: number } | { kind: "other"; mode: string } | null {
  if (!/^[0-9a-f]{40,64}$/.test(commit) || rel.startsWith("-") || rel.includes("\0")) return null;
  const out = git(root, ["ls-tree", "-z", "--long", "--full-tree", commit, "--", rel]);
  if (out === null) return null;
  const line = out.split("\0").find((l) => l.length > 0);
  if (!line) return { kind: "absent" };
  const m = /^(\d+) (\w+) [0-9a-f]+\s+(-|\d+)\t(.*)$/s.exec(line);
  if (!m || m[4] !== rel) return null;
  if (m[1] === "100644" || m[1] === "100755") return { kind: "blob", size: Number(m[3]) };
  return { kind: "other", mode: m[1]! };
}

/** The checked-out branch's full ref name (`refs/heads/x`), or null when HEAD is detached. */
export function currentBranchRef(root: string): string | null {
  return git(root, ["symbolic-ref", "-q", "HEAD"])?.trim() || null;
}

/** The full ref name a ref expression names (`main` → `refs/heads/main`), or null for a commit expression. */
export function fullRefName(root: string, ref: string): string | null {
  if (!ref || ref.startsWith("-") || /[\0\s]/.test(ref)) return null;
  return git(root, ["rev-parse", "--symbolic-full-name", ref])?.trim() || null;
}

/** Full names of all refs (branches, remote-tracking branches, tags) whose history contains `commit`. */
export function refsContaining(root: string, commit: string): string[] {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return [];
  return (git(root, ["for-each-ref", "--format=%(refname)", "--contains", commit]) ?? "").split("\n").filter(Boolean);
}

/** Repository-relative paths of the files under `dir` at a commit (recursive), sorted. */
export function filesAtCommit(root: string, commit: string, dir: string): string[] {
  if (!/^[0-9a-f]{40,64}$/.test(commit) || dir.startsWith("-") || dir.includes("\0")) return [];
  return (git(root, ["ls-tree", "-r", "-z", "--name-only", commit, "--", dir]) ?? "")
    .split("\0")
    .filter(Boolean)
    .sort();
}

/** Whether `ancestor` is `commit` or one of its ancestors (`git merge-base --is-ancestor`). */
export function isAncestor(root: string, ancestor: string, commit: string): boolean {
  if (!/^[0-9a-f]{40,64}$/.test(ancestor) || !/^[0-9a-f]{40,64}$/.test(commit)) return false;
  return git(root, ["merge-base", "--is-ancestor", ancestor, commit]) !== null;
}

/**
 * Repository-relative paths that differ between `commit` and the working tree (committed,
 * staged and unstaged changes, deletions, and untracked files not ignored), sorted. Read-only.
 * Null when `commit` is not a commit here.
 */
export function changedFilesSince(root: string, commit: string): string[] | null {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return null;
  const diff = git(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--no-renames", commit, "--"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (diff === null || untracked === null) return null;
  return [...new Set([...diff.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
}

/** The best common ancestor of two commits (`git merge-base`), or null (unrelated histories, unknown commit). */
export function mergeBase(root: string, a: string, b: string): string | null {
  if (!/^[0-9a-f]{40,64}$/.test(a) || !/^[0-9a-f]{40,64}$/.test(b)) return null;
  return git(root, ["merge-base", a, b])?.trim() || null;
}

/** Repository-relative paths that differ between two commits (no renames), sorted. Null when either is not a commit here. */
export function changedFilesBetween(root: string, from: string, to: string): string[] | null {
  if (!/^[0-9a-f]{40,64}$/.test(from) || !/^[0-9a-f]{40,64}$/.test(to)) return null;
  const diff = git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    "--no-renames",
    from,
    to,
    "--",
  ]);
  return diff === null ? null : [...new Set(diff.split("\0").filter(Boolean))].sort();
}
