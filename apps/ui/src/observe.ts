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
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { OPEN_READ_NOFOLLOW, readChunks } from "@vcv/core";
import { projectStatus } from "@vcv/repo";
import { StateChangedError, modelKey } from "./session.ts";

/** Budget for hashing .vcv/. Mutable for tests only. Past it, nothing is served (no size/mtime stand-in). */
export const OBSERVE_LIMITS = { files: 5000, bytes: 64 * 1024 * 1024 };
const ATTEMPTS = 3;
const CHUNK = 64 * 1024;

/**
 * Test seams: `beforeOpen` after a store entry's lstat; `atOpen` just before a contained open (after
 * its ancestor check); `afterOpen` just after it. `atOpen`/`afterOpen` take checkout-relative paths.
 */
export const observeTestHooks: {
  beforeOpen?: (rel: string) => void;
  atOpen?: (rel: string) => void;
  afterOpen?: (rel: string) => void;
} = {};

/** The checkout cannot be observed exactly, so no answer is composed from it (HTTP 422). */
export class ObservationLimit extends Error {
  readonly code = "OBSERVATION_LIMIT";
}

export type ObserveOptions = { ref?: string };

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code ?? "unreadable";

/**
 * Every folder from the checkout root down to `rel` (exclusive; inclusive with `self`) is a
 * plain directory, not a symlink, so a path under it cannot leave the checkout.
 */
function assertPlainAncestors(rootReal: string, rel: string, fail: (why: string) => never, self = false): void {
  const parts = rel.split("/");
  const upto = self ? parts.length : parts.length - 1;
  for (let i = 1; i <= upto; i++) {
    const s = lstatSync(join(rootReal, ...parts.slice(0, i)), { throwIfNoEntry: false });
    if (!s?.isDirectory())
      fail(
        `${parts.slice(0, i).join("/")} is no longer a plain folder inside the checkout; the read cannot be contained`,
      );
  }
}

/**
 * Open the regular file at `rel` under the checkout's real root by descriptor (never through a
 * final symlink, never blocking on a FIFO) and prove the bytes it reads are inside the checkout:
 * after the open, every ancestor is still a plain directory and the path still names the very
 * file (device and inode) that was opened. A parent folder swapped for a symlink, even if swapped
 * back, is refused. Null if the file vanished before it was opened. The caller closes the fd.
 */
export function openContained(rootReal: string, rel: string, fail: (why: string) => never): number | null {
  if (rel.startsWith("/") || rel.split("/").includes("..")) fail("the path leaves the checkout");
  assertPlainAncestors(rootReal, rel, fail);
  const abs = join(rootReal, rel);
  let fd: number;
  try {
    observeTestHooks.atOpen?.(rel);
    fd = openSync(abs, OPEN_READ_NOFOLLOW);
  } catch (e) {
    if (e instanceof ObservationLimit) throw e;
    if (errno(e) === "ENOENT") return null;
    if (errno(e) === "ELOOP") return fail("replaced by a symlink while it was read");
    return fail(errno(e));
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) fail("replaced by something other than a regular file while it was read");
    observeTestHooks.afterOpen?.(rel);
    assertPlainAncestors(rootReal, rel, fail);
    const here = lstatSync(abs, { throwIfNoEntry: false });
    if (!here || here.dev !== opened.dev || here.ino !== opened.ino)
      fail("the file that was opened is not the one at this path inside the checkout");
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
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
  const store = st.storeDir ? relative(st.root, st.storeDir).split(sep).join("/") : "";
  const at = (r: string) => (r ? `${store}/${r}` : store);
  /** Hash one regular file by a contained descriptor; false if it vanished before it was opened. */
  const hashFile = (r: string): boolean => {
    const fd = openContained(rootReal, at(r), (why) => refuse(r, why));
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
  // A listing read through a swapped parent can only add names; each one is then lstat'd and
  // opened through a contained descriptor, so nothing outside the checkout is ever hashed.
  const walk = (rel: string, expect?: { dev: number; ino: number }) => {
    const dir = join(rootReal, at(rel));
    assertPlainAncestors(rootReal, at(rel), (why) => refuse(rel || ".", why), true);
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
    assertPlainAncestors(rootReal, at(rel), (why) => refuse(rel || ".", why), true);
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
        walk(r, { dev: s.dev, ino: s.ino });
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
        assertPlainAncestors(rootReal, at(r), (why) => refuse(r, why));
        const again = lstatSync(p, { throwIfNoEntry: false });
        if (!again?.isSymbolicLink() || again.dev !== s.dev || again.ino !== s.ino)
          refuse(r, "the link was replaced while it was read");
        bytes += Buffer.byteLength(target);
        if (bytes > OBSERVE_LIMITS.bytes) refuse(r, `more than ${OBSERVE_LIMITS.bytes} bytes`);
        h.update(`\0link:${r}\0${target}`);
        continue;
      }
      if (!s.isFile()) refuse(r, "not a regular file, directory or symlink");
      if (!hashFile(r)) h.update(`\0gone:${r}`);
    }
  };
  if (st.storeDir) walk("");
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
