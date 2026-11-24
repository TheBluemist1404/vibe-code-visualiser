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
// The checkout is untrusted and may change while it is hashed. Every read is contained during
// path resolution: the checkout root is opened once as a directory descriptor, and each folder
// below it is opened relative to its parent's descriptor (through /proc/self/fd/<fd>/<name>), with
// O_NOFOLLOW, so no component, parent or final, is ever followed through a symlink. A folder
// swapped for a symlink fails to open; a folder swapped after it was opened is still read through
// the descriptor that was opened, inside the checkout. Files are opened the same way, non-blocking,
// checked with fstat and streamed against the bytes actually read. Where the platform has no
// descriptor-relative open (no /proc/self/fd: macOS, Windows), nothing is observed:
// OBSERVATION_LIMIT, never a weaker path-based read.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { OPEN_READ_NOFOLLOW, readChunks } from "@vcv/core";
import { projectStatus, resolveInside } from "@vcv/repo";
import { StateChangedError, modelKey } from "./session.ts";

/** Budget for hashing .vcv/. Mutable for tests only. Past it, nothing is served (no size/mtime stand-in). */
export const OBSERVE_LIMITS = { files: 5000, bytes: 64 * 1024 * 1024 };
const ATTEMPTS = 3;
const CHUNK = 64 * 1024;

/**
 * Test seams: `beforeOpen` after a store entry's lstat (store-relative path); `atOpen` just before a
 * contained file is opened, its parent folders already held open (checkout-relative path).
 */
export const observeTestHooks: {
  beforeOpen?: (rel: string) => void;
  atOpen?: (rel: string) => void;
  /** Behave as a platform without descriptor-relative opens (macOS, Windows). */
  noDescriptorReads?: boolean;
} = {};

/** The checkout cannot be observed exactly, so no answer is composed from it (HTTP 422). */
export class ObservationLimit extends Error {
  readonly code = "OBSERVATION_LIMIT";
}

const SOURCE_MAX_FILES = 2000;
const SOURCE_MAX_BYTES = 32 * 1024 * 1024;
const CLAIM_MAX_BYTES = 1024 * 1024;

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

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code ?? "unreadable";

const PROC_FD = "/proc/self/fd";
const OPEN_DIR =
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
/** A child of an open directory, resolved from the descriptor, not from a path that can move. */
const at = (dirFd: number, name: string) => `${PROC_FD}/${dirFd}/${name}`;

let descriptorReads: boolean | undefined;
/** Whether this platform resolves a name relative to an open directory descriptor (Linux /proc). */
function containedReadsAvailable(): boolean {
  if (observeTestHooks.noDescriptorReads) return false;
  if (descriptorReads === undefined) {
    descriptorReads = false;
    if (process.platform === "linux") {
      try {
        const fd = openSync("/", OPEN_DIR);
        try {
          readdirSync(`${PROC_FD}/${fd}`);
          descriptorReads = true;
        } finally {
          closeSync(fd);
        }
      } catch {
        // no usable /proc
      }
    }
  }
  return descriptorReads;
}

const safeName = (n: string) => n !== "" && n !== "." && n !== ".." && !n.includes("/") && !n.includes("\0");

/** Open the checkout's real root as a directory descriptor; refuse where reads cannot be contained. */
export function openRoot(rootReal: string, fail: (why: string) => never): number {
  if (!containedReadsAvailable())
    fail("this platform has no descriptor-relative open (/proc/self/fd), so reads cannot be contained in the checkout");
  try {
    return openSync(rootReal, OPEN_DIR);
  } catch (e) {
    return fail(`the checkout root cannot be opened (${errno(e)})`);
  }
}

/** Open the folder `name` inside the open folder `dirFd`, never through a symlink. Null if it is gone. */
function openChildDir(dirFd: number, name: string, fail: (why: string) => never): number | null {
  if (!safeName(name)) fail(`"${name}" is not a plain name inside the checkout`);
  try {
    return openSync(at(dirFd, name), OPEN_DIR);
  } catch (e) {
    if (errno(e) === "ENOENT") return null;
    if (errno(e) === "ENOTDIR" || errno(e) === "ELOOP") return fail("no longer a plain folder inside the checkout");
    return fail(errno(e));
  }
}

/** Open the regular file `name` inside the open folder `dirFd`: no symlink, no blocking. Null if gone. */
function openChildFile(dirFd: number, name: string, fail: (why: string) => never): number | null {
  if (!safeName(name)) fail(`"${name}" is not a plain name inside the checkout`);
  let fd: number;
  try {
    fd = openSync(at(dirFd, name), OPEN_READ_NOFOLLOW);
  } catch (e) {
    if (errno(e) === "ENOENT") return null;
    if (errno(e) === "ELOOP") return fail("replaced by a symlink while it was read");
    return fail(errno(e));
  }
  try {
    if (!fstatSync(fd).isFile()) fail("replaced by something other than a regular file while it was read");
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/**
 * Open the regular file at checkout-relative `rel` by walking down from the root descriptor one
 * folder at a time (see the header). Null if any part of the path is gone. The caller closes the fd.
 */
export function openContained(rootReal: string, rel: string, fail: (why: string) => never): number | null {
  const parts = rel.split("/");
  let dir = openRoot(rootReal, fail);
  try {
    for (const name of parts.slice(0, -1)) {
      const next = openChildDir(dir, name, fail);
      if (next === null) return null;
      closeSync(dir);
      dir = next;
    }
    observeTestHooks.atOpen?.(rel);
    return openChildFile(dir, parts[parts.length - 1] ?? "", fail);
  } finally {
    closeSync(dir);
  }
}

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
  const rootReal = realpathSync(st.root);
  const storeRel = st.storeDir ? relative(st.root, st.storeDir).split(sep).join("/") : "";
  /** Hash one regular file in the open folder `dirFd`; false if it vanished before it was opened. */
  const hashFile = (dirFd: number, name: string, r: string): boolean => {
    const fd = openChildFile(dirFd, name, (why) => refuse(r, why));
    if (fd === null) return false;
    try {
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
  /** Hash the open folder `dirFd` (store-relative `rel`): listed, stat'd and read only through it. */
  const walk = (dirFd: number, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(`${PROC_FD}/${dirFd}`).sort();
    } catch (e) {
      return refuse(rel || ".", errno(e));
    }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      if (r === "cache") continue; // the writer lock and other local state
      const s = lstatSync(at(dirFd, n), { throwIfNoEntry: false });
      if (!s) {
        h.update(`\0gone:${r}`);
        continue;
      }
      observeTestHooks.beforeOpen?.(r);
      if (s.isDirectory()) {
        const child = openChildDir(dirFd, n, (why) => refuse(r, why));
        if (child === null) {
          h.update(`\0gone:${r}`);
          continue;
        }
        try {
          h.update(`\0dir:${r}`);
          walk(child, r);
        } finally {
          closeSync(child);
        }
        continue;
      }
      files += 1;
      if (files > OBSERVE_LIMITS.files) refuse(r, `more than ${OBSERVE_LIMITS.files} files`);
      if (s.isSymbolicLink()) {
        // The link itself is the state; where it points is outside the store and never read.
        let target: string;
        try {
          target = readlinkSync(at(dirFd, n));
        } catch (e) {
          return refuse(r, errno(e) === "EINVAL" ? "replaced by a non-link while it was read" : errno(e));
        }
        bytes += Buffer.byteLength(target);
        if (bytes > OBSERVE_LIMITS.bytes) refuse(r, `more than ${OBSERVE_LIMITS.bytes} bytes`);
        h.update(`\0link:${r}\0${target}`);
        continue;
      }
      if (!s.isFile()) refuse(r, "not a regular file, directory or symlink");
      if (!hashFile(dirFd, n, r)) h.update(`\0gone:${r}`);
    }
  };
  if (st.storeDir) {
    let dir = openRoot(rootReal, (why) => refuse(".", why));
    try {
      let present = true;
      for (const name of storeRel.split("/")) {
        const next = openChildDir(dir, name, (why) => refuse(".", why));
        if (next === null) {
          present = false;
          break;
        }
        closeSync(dir);
        dir = next;
      }
      if (present) walk(dir, "");
      else h.update("\0missing:store");
    } finally {
      closeSync(dir);
    }
  }
  if (opts.source) sourceFingerprint(rootReal, h);
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
 * The working tree's changed and claimed files (see ObserveOptions.source). Paths are resolved by the
 * binding verifier's own rules (resolveInside: exact-case names, symlinks anywhere in the path
 * followed only if they stay in the checkout), then read through openContained.
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

function hashPath(
  root: string,
  rel: string,
  h: ReturnType<typeof createHash>,
  budget: { bytes: number },
  fromStatus: boolean,
): void {
  const s = lstatSync(join(root, rel), { throwIfNoEntry: false });
  if (s?.isDirectory()) {
    // git status lists a directory only for a submodule or nested repository; its files are not observed.
    if (fromStatus)
      throw new ObservationLimit(
        `${rel} is a submodule or nested repository with changes; this view does not observe its working tree. Commit or clean it and retry`,
      );
    h.update("directory");
    return;
  }
  if (s?.isSymbolicLink()) {
    try {
      h.update(`link:${readlinkSync(join(root, rel))}\0`);
    } catch {
      h.update("link:unreadable\0");
    }
  }
  // The same resolution the binding verifier uses, so a locator through an in-checkout symlinked
  // folder is observed exactly where the resolver reads it, and one that leaves is never read.
  const where = resolveInside(root, rel);
  if (!where.ok) {
    h.update(`unresolved:${where.reason}`);
    return;
  }
  const inside = relative(root, where.abs).split(sep).join("/");
  h.update(`at:${inside}\0`);
  observeTestHooks.beforeOpen?.(`source:${rel}`);
  const file = createHash("sha256");
  const found = streamRegular(root, inside, (chunk) => {
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
 * Stream the regular file at checkout-relative `rel` through openContained (no symlink anywhere in
 * the path, non-blocking, fstat-checked). False if it vanished first.
 */
function streamRegular(rootReal: string, rel: string, onChunk: (chunk: Buffer) => void): boolean {
  const fd = openContained(rootReal, rel, (why) => {
    throw new ObservationLimit(`cannot observe ${rel} exactly (${why})`);
  });
  if (fd === null) return false;
  try {
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

/** Locator paths named by binding claims in .vcv/bindings/, listed and read through held descriptors. */
function claimedPaths(rootReal: string): string[] {
  const fail = (why: string): never => {
    throw new ObservationLimit(`cannot observe .vcv/bindings exactly (${why})`);
  };
  let dir = openRoot(rootReal, fail);
  const paths = new Set<string>();
  try {
    for (const name of [".vcv", "bindings"]) {
      const next = openChildDir(dir, name, fail);
      if (next === null) return [];
      closeSync(dir);
      dir = next;
    }
    for (const n of readdirSync(`${PROC_FD}/${dir}`)
      .filter((x) => x.endsWith(".json"))
      .sort()) {
      const st = lstatSync(at(dir, n), { throwIfNoEntry: false });
      if (!st?.isFile() || st.size > CLAIM_MAX_BYTES) continue; // covered by the .vcv/ walk
      const fd = openChildFile(dir, n, (why) => fail(`${n}: ${why}`));
      if (fd === null) continue;
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        readChunks(fd, CHUNK, (chunk) => {
          size += chunk.length;
          if (size > CLAIM_MAX_BYTES) fail(`${n} grew while it was read`);
          chunks.push(Buffer.from(chunk));
          return true;
        });
      } finally {
        closeSync(fd);
      }
      try {
        const p = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { locator?: { path?: unknown } }).locator
          ?.path;
        if (typeof p === "string" && p && !p.startsWith("/") && !p.split("/").includes("..")) paths.add(p);
      } catch {
        // an unparseable claim is part of the .vcv/ bytes already
      }
    }
  } finally {
    closeSync(dir);
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
