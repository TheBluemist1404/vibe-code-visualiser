// One identity for "the checkout as a read saw it" (Issue #44 review): the model identity, Git
// commit, branch and dirty state, every byte under .vcv/ except the local cache/ (HEAD, revisions,
// change records, attestations, the trust list, bindings, implementation reports), and, when the
// host was given one, the commit a named ref resolves to. Two observations that differ in any of
// these are different states, even under the same revision ID.
//
// An answer built from several reads is served only if the identity taken before the first read
// equals the one taken after the last; otherwise the reads are retried, and a checkout that keeps
// moving is STATE_CHANGED. Nothing is stitched together from two states.
//
// The identity is exact or it is refused: a store past the hashing budget, or an entry that is
// not a regular file, directory or symlink, or cannot be read, is OBSERVATION_LIMIT. Size and
// mtime never stand in for content, since both can be kept while the bytes change.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { projectStatus } from "@vcv/repo";
import { StateChangedError, modelKey } from "./session.ts";

/** Budget for hashing .vcv/. Mutable for tests only. Past it, nothing is served (no size/mtime stand-in). */
export const OBSERVE_LIMITS = { files: 5000, bytes: 64 * 1024 * 1024 };
const ATTEMPTS = 3;

export type ObserveOptions = {
  ref?: string;
  /**
   * Also fingerprint the working tree's content: the bytes of every file Git reports as
   * modified, added, deleted, renamed or untracked (not ignored). Committed, unchanged files are
   * covered by the commit ID. For reads that inspect source and test files (evidence,
   * implementation status, reconciliation, the gate), so a dirty→dirty edit between two reads
   * is seen. Over budget or unreadable: ObservationLimit, never a silent pass.
   */
  source?: boolean;
};

/** The working tree could not be fingerprinted within bounds: the answer is refused, not guessed. */
export class ObservationLimit extends Error {
  readonly code = "OBSERVATION_LIMIT";
}

const SOURCE_MAX_FILES = 2000;
const SOURCE_MAX_BYTES = 32 * 1024 * 1024;

export function checkoutIdentity(path: string, opts: ObserveOptions = {}): string {
  const st = projectStatus(path);
  const h = createHash("sha256");
  h.update(`${st.state}\0${modelKey(st) ?? ""}\0${st.git?.commit ?? ""}\0${st.git?.branch ?? ""}\0${st.git?.dirty}\0`);
  let files = 0;
  let bytes = 0;
  const refuse = (rel: string, why: string): never => {
    throw new ObservationLimit(
      `cannot observe .vcv/${rel} exactly (${why}); nothing is served from a state that cannot be pinned down`,
    );
  };
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (e) {
      // A directory removed between listing and reading is a change, not a hole to paper over.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        h.update(`\0missing:${rel}`);
        return;
      }
      return refuse(rel || ".", (e as NodeJS.ErrnoException).code ?? "unreadable");
    }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      if (r === "cache") continue; // the writer lock and other local state
      const p = join(dir, n);
      const s = lstatSync(p, { throwIfNoEntry: false });
      if (!s) {
        h.update(`\0gone:${r}`);
        continue;
      }
      if (s.isDirectory()) {
        h.update(`\0dir:${r}`);
        walk(p, r);
        continue;
      }
      files += 1;
      bytes += s.size;
      if (files > OBSERVE_LIMITS.files) refuse(r, `more than ${OBSERVE_LIMITS.files} files`);
      if (bytes > OBSERVE_LIMITS.bytes) refuse(r, `more than ${OBSERVE_LIMITS.bytes} bytes`);
      if (s.isSymbolicLink()) {
        // The link itself is the state; where it points is outside the store.
        let target: string;
        try {
          target = readlinkSync(p);
        } catch (e) {
          return refuse(r, (e as NodeJS.ErrnoException).code ?? "unreadable link");
        }
        h.update(`\0link:${r}\0${target}`);
        continue;
      }
      if (!s.isFile()) refuse(r, "not a regular file, directory or symlink");
      let content: Buffer;
      try {
        content = readFileSync(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          h.update(`\0gone:${r}`);
          continue;
        }
        return refuse(r, (e as NodeJS.ErrnoException).code ?? "unreadable");
      }
      h.update(`\0file:${r}\0${content.length}\0`);
      h.update(content);
    }
  };
  if (st.storeDir) walk(st.storeDir, "");
  if (opts.source) sourceFingerprint(st.root, h);
  if (opts.ref) {
    try {
      h.update(
        `\0ref:${execFileSync("git", ["rev-parse", "--verify", "--quiet", `${opts.ref}^{commit}`], { cwd: st.root, encoding: "utf8" }).trim()}`,
      );
    } catch {
      h.update("\0ref:unresolved");
    }
  }
  return h.digest("hex");
}

/**
 * The supported source path model (docs/ui.md, "Evidence and the pre-merge page"):
 * - committed, unchanged files: covered by the commit ID;
 * - every path `git status` reports as changed or untracked (not ignored): its bytes; a symlink:
 *   its link text plus the bytes of what it resolves to inside the checkout (or that it leaves
 *   the checkout, which the resolver refuses anyway);
 * - every file a binding claim's locator names, wherever it is (also ignored files, also behind
 *   unchanged tracked symlinks): the bytes the resolver would read, resolved the same way;
 * - a submodule or nested repository with changes: refused (OBSERVATION_LIMIT), because its
 *   working tree is not observed here.
 * Anything over budget or unreadable is refused, never hashed as a placeholder.
 */
function sourceFingerprint(root: string, h: ReturnType<typeof createHash>): void {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    throw new ObservationLimit(`cannot list the working tree's changes: ${(e as Error).message}`);
  }
  const entries = out.split("\0").filter(Boolean);
  const claimed = claimedPaths(root);
  if (entries.length + claimed.length > SOURCE_MAX_FILES)
    throw new ObservationLimit(
      `${entries.length} changed or untracked files and ${claimed.length} claimed paths is more than this view checks (${SOURCE_MAX_FILES}); commit or clean some and retry`,
    );
  const budget = { bytes: 0 };
  h.update("\0source");
  for (const e of entries.sort()) {
    h.update(`\0${e}\0`);
    hashPath(root, e.slice(3), h, budget, true);
  }
  h.update("\0claimed");
  for (const rel of claimed) {
    h.update(`\0${rel}\0`);
    hashPath(root, rel, h, budget, false);
  }
}

const realRootOf = (root: string) => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};

function hashPath(
  root: string,
  rel: string,
  h: ReturnType<typeof createHash>,
  budget: { bytes: number },
  fromStatus: boolean,
): void {
  const abs = join(root, rel);
  const s = lstatSync(abs, { throwIfNoEntry: false });
  if (!s) {
    h.update("absent");
    return;
  }
  if (s.isDirectory()) {
    // git status lists a directory only for a submodule or nested repository; its files are not observed.
    if (fromStatus)
      throw new ObservationLimit(
        `${rel} is a submodule or nested repository with changes; this view does not observe its working tree. Commit or clean it and retry`,
      );
    h.update("directory");
    return;
  }
  let target = abs;
  if (s.isSymbolicLink()) {
    try {
      h.update(`link:${readlinkSync(abs)}\0`);
      target = realpathSync(abs);
    } catch {
      h.update("dangling");
      return;
    }
    const realRoot = realRootOf(root);
    if (target !== realRoot && !target.startsWith(realRoot + sep)) {
      h.update("outside"); // the resolver refuses a symlink that leaves the checkout
      return;
    }
  }
  const t = statSync(target, { throwIfNoEntry: false });
  if (!t) {
    h.update("absent");
    return;
  }
  if (t.isDirectory()) {
    h.update("directory");
    return;
  }
  if (!t.isFile()) throw new ObservationLimit(`${rel} is a special file; this view does not observe it`);
  budget.bytes += t.size;
  if (budget.bytes > SOURCE_MAX_BYTES)
    throw new ObservationLimit(
      `changed, untracked and claimed files add up to more than ${SOURCE_MAX_BYTES} bytes; this view cannot observe them consistently`,
    );
  try {
    h.update(readFileSync(target));
  } catch (err) {
    throw new ObservationLimit(`cannot read ${rel}: ${(err as Error).message}`);
  }
}

/** Locator paths named by binding claims in .vcv/bindings/ (unreadable claims are covered by the .vcv/ walk). */
function claimedPaths(root: string): string[] {
  const dir = join(root, ".vcv", "bindings");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const paths = new Set<string>();
  for (const n of names) {
    try {
      const st = lstatSync(join(dir, n));
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      const p = (JSON.parse(readFileSync(join(dir, n), "utf8")) as { locator?: { path?: unknown } }).locator?.path;
      if (typeof p === "string" && p && !p.startsWith("/") && !p.split("/").includes("..")) paths.add(p);
    } catch {
      // an unreadable claim is part of the .vcv/ bytes already
    }
  }
  return [...paths].sort();
}

/**
 * Run `read` between two identity observations and return its answer only if they match;
 * retry a few times, then STATE_CHANGED. `read` must not write.
 */
export function consistentRead<T>(path: string, read: () => T, opts: ObserveOptions = {}): T {
  for (let i = 0; i < ATTEMPTS; i++) {
    const before = checkoutIdentity(path, opts);
    const out = read();
    if (checkoutIdentity(path, opts) === before) return out;
  }
  throw new StateChangedError(
    "the checkout kept changing while this was read (model, Git, proposal records or attestations); nothing was combined from two states. Try again.",
  );
}
