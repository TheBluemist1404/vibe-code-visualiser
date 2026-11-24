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
import { relative, sep } from "node:path";
import { ContainmentUnavailable, OPEN_READ_NOFOLLOW, readChunks, withContainedReads } from "@vcv/core";
import { projectStatus, resolveProjectRoot } from "@vcv/repo";
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

export type ObserveOptions = { ref?: string };

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
 * Run `fn` with every repository read under the checkout resolved from a descriptor held on its
 * root (@vcv/core withContainedReads): no folder on the way is followed through a symlink, so a
 * swap while an answer is composed cannot make it read outside the checkout. Where that cannot be
 * enforced, or a read met a swapped folder, nothing is served: OBSERVATION_LIMIT.
 */
function contained<T>(path: string, fn: () => T): T {
  try {
    return withContainedReads(realpathSync(resolveProjectRoot(path).root), fn);
  } catch (e) {
    if (e instanceof ContainmentUnavailable)
      throw new ObservationLimit(`a read could not be contained in the checkout: ${e.message}`);
    throw e;
  }
}

/**
 * Run `read` between two identity observations and return its answer only if they match;
 * retry a few times, then STATE_CHANGED. `read` must not write. Both observations and the read
 * run in one contained scope, so none of them reads through a folder swapped out of the checkout.
 */
export function consistentRead<T>(path: string, read: () => T, opts: ObserveOptions = {}): T {
  for (let i = 0; i < ATTEMPTS; i++) {
    const answer = contained(path, () => {
      const before = checkoutIdentity(path, opts);
      const out = read();
      return checkoutIdentity(path, opts) === before ? { out } : null;
    });
    if (answer) return answer.out;
  }
  throw new StateChangedError(
    "the checkout kept changing while this was read (model, Git, proposal records or attestations); nothing was combined from two states. Try again.",
  );
}
