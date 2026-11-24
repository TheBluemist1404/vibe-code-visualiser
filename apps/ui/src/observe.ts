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
//
// The checkout is untrusted and may change while it is hashed. Files are opened by descriptor
// without following a final symlink and without blocking on a FIFO, re-checked with fstat, and
// streamed against the bytes actually read, so a swap after the lstat cannot redirect, block or
// overrun the read (the same pattern as readStoreFile in @vcv/core). A directory that stops being
// the directory that was listed is refused.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { OPEN_READ_NOFOLLOW, readChunks } from "@vcv/core";
import { projectStatus } from "@vcv/repo";
import { StateChangedError, modelKey } from "./session.ts";

/** Budget for hashing .vcv/. Mutable for tests only. Past it, nothing is served (no size/mtime stand-in). */
export const OBSERVE_LIMITS = { files: 5000, bytes: 64 * 1024 * 1024 };
const ATTEMPTS = 3;
const CHUNK = 64 * 1024;

/** Test seam: runs after an entry's lstat and before it is opened or listed. */
export const observeTestHooks: { beforeOpen?: (rel: string) => void } = {};

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
const CLAIM_MAX_BYTES = 1024 * 1024;

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
  const errno = (e: unknown) => (e as NodeJS.ErrnoException).code ?? "unreadable";
  /** Hash one regular file by descriptor; false if it vanished before it was opened. */
  const hashFile = (p: string, r: string): boolean => {
    let fd: number;
    try {
      fd = openSync(p, OPEN_READ_NOFOLLOW);
    } catch (e) {
      if (errno(e) === "ENOENT") return false;
      if (errno(e) === "ELOOP") return refuse(r, "replaced by a symlink while it was read");
      return refuse(r, errno(e));
    }
    try {
      if (!fstatSync(fd).isFile()) refuse(r, "replaced by something other than a regular file while it was read");
      const file = createHash("sha256");
      let n = 0;
      readChunks(fd, CHUNK, (chunk) => {
        n += chunk.length;
        bytes += chunk.length;
        if (bytes > OBSERVE_LIMITS.bytes) refuse(r, `more than ${OBSERVE_LIMITS.bytes} bytes`);
        file.update(chunk);
        return true;
      });
      h.update(`\0file:${r}\0${n}\0${file.digest("hex")}`);
      return true;
    } catch (e) {
      if (e instanceof ObservationLimit) throw e;
      return refuse(r, errno(e));
    } finally {
      closeSync(fd);
    }
  };
  const walk = (dir: string, rel: string, expect?: { dev: number; ino: number }) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (e) {
      // A directory removed between listing and reading is a change, not a hole to paper over.
      if (errno(e) === "ENOENT") {
        h.update(`\0missing:${rel}`);
        return;
      }
      return refuse(rel || ".", errno(e));
    }
    if (expect) {
      const again = lstatSync(dir, { throwIfNoEntry: false });
      if (!again?.isDirectory() || again.dev !== expect.dev || again.ino !== expect.ino)
        refuse(rel, "the directory was replaced while it was listed");
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
      observeTestHooks.beforeOpen?.(r);
      if (s.isDirectory()) {
        h.update(`\0dir:${r}`);
        walk(p, r, { dev: s.dev, ino: s.ino });
        continue;
      }
      files += 1;
      if (files > OBSERVE_LIMITS.files) refuse(r, `more than ${OBSERVE_LIMITS.files} files`);
      if (s.isSymbolicLink()) {
        // The link itself is the state; where it points is outside the store and never read.
        let target: string;
        try {
          target = readlinkSync(p);
        } catch (e) {
          return refuse(r, errno(e) === "EINVAL" ? "replaced by a non-link while it was read" : errno(e));
        }
        bytes += Buffer.byteLength(target);
        if (bytes > OBSERVE_LIMITS.bytes) refuse(r, `more than ${OBSERVE_LIMITS.bytes} bytes`);
        h.update(`\0link:${r}\0${target}`);
        continue;
      }
      if (!s.isFile()) refuse(r, "not a regular file, directory or symlink");
      if (!hashFile(p, r)) h.update(`\0gone:${r}`);
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
  observeTestHooks.beforeOpen?.(`source:${rel}`);
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
  const file = createHash("sha256");
  const found = streamRegular(target, rel, (chunk) => {
    budget.bytes += chunk.length;
    if (budget.bytes > SOURCE_MAX_BYTES)
      throw new ObservationLimit(
        `changed, untracked and claimed files add up to more than ${SOURCE_MAX_BYTES} bytes; this view cannot observe them consistently`,
      );
    file.update(chunk);
  });
  h.update(found ? `bytes:${file.digest("hex")}` : "absent");
}

/**
 * Stream a regular file by descriptor (never through a final symlink, never blocking on a FIFO,
 * re-checked with fstat), so a swap after the caller's stat cannot redirect or block the read.
 * False if it vanished first; ObservationLimit if it turned into something else or cannot be read.
 */
function streamRegular(abs: string, rel: string, onChunk: (chunk: Buffer) => void): boolean {
  let fd: number;
  try {
    fd = openSync(abs, OPEN_READ_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw new ObservationLimit(
      code === "ELOOP" ? `${rel} was replaced by a symlink while it was read` : `cannot read ${rel} (${code})`,
    );
  }
  try {
    if (!fstatSync(fd).isFile())
      throw new ObservationLimit(`${rel} was replaced by something other than a regular file while it was read`);
    readChunks(fd, CHUNK, (chunk) => {
      onChunk(chunk);
      return true;
    });
    return true;
  } catch (e) {
    if (e instanceof ObservationLimit) throw e;
    throw new ObservationLimit(`cannot read ${rel}: ${(e as Error).message}`);
  } finally {
    closeSync(fd);
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
      if (!st.isFile() || st.size > CLAIM_MAX_BYTES) continue;
      const chunks: Buffer[] = [];
      let size = 0;
      streamRegular(join(dir, n), `.vcv/bindings/${n}`, (chunk) => {
        size += chunk.length;
        if (size > CLAIM_MAX_BYTES) throw new ObservationLimit(`.vcv/bindings/${n} grew while it was read`);
        chunks.push(Buffer.from(chunk));
      });
      const text = Buffer.concat(chunks).toString("utf8");
      const p = (JSON.parse(text) as { locator?: { path?: unknown } }).locator?.path;
      if (typeof p === "string" && p && !p.startsWith("/") && !p.split("/").includes("..")) paths.add(p);
    } catch (e) {
      if (e instanceof ObservationLimit) throw e; // swapped or growing: refuse, do not skip
      // an unparseable claim is part of the .vcv/ bytes already
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
