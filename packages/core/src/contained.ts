// Checkout-contained reads (Issue #44/#45 review). A host that serves data from an untrusted,
// concurrently changing checkout runs its reads inside withContainedReads(root, fn). While that
// scope is active, every read helper below resolves a path under `root` from a directory
// descriptor held on the root, one folder at a time, each opened with O_NOFOLLOW relative to its
// parent's descriptor (/proc/self/fd/<fd>/<name>). No component is followed through a symlink, so
// no read can leave the checkout, whatever is swapped while it runs. A folder that is a symlink
// when it is reached is a containment violation: the helper fails, and the whole scope fails with
// ContainmentUnavailable even if a caller swallowed the error, so no answer is built from it.
//
// Outside a scope, and for paths outside the root, the helpers are the plain node:fs calls, so the
// CLI behaves exactly as before. Where the platform has no descriptor-relative open (no
// /proc/self/fd: macOS, Windows), withContainedReads refuses instead of reading less safely.
import { closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readlinkSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { relative, resolve, sep } from "node:path";

const PROC_FD = "/proc/self/fd";
const OPEN_DIR =
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const WRITE_FLAGS = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND;
const at = (dirFd: number, name: string) => `${PROC_FD}/${dirFd}/${name}`;

/** The host cannot enforce a checkout-rooted read here, or a read in the scope met a symlinked folder. */
export class ContainmentUnavailable extends Error {
  readonly code = "CONTAINMENT_UNAVAILABLE";
}

type Scope = { root: string; aliases: string[]; fd: number; violation?: string };
let scope: Scope | null = null;

/**
 * Test seams: force the unsupported-platform path; run code after a folder is opened in the walk;
 * run code just before a file is opened for reading (in and outside a scope).
 */
export const containedTestHooks: {
  unavailable?: boolean;
  afterDir?: (abs: string) => void;
  beforeOpen?: (abs: string) => void;
} = {};

let supported: boolean | undefined;
/** Whether this platform resolves a name relative to an open directory descriptor (Linux /proc). */
export function containedReadsAvailable(): boolean {
  if (containedTestHooks.unavailable) return false;
  if (supported === undefined) {
    supported = false;
    if (process.platform === "linux") {
      try {
        const fd = openSync("/", OPEN_DIR);
        try {
          readdirSync(`${PROC_FD}/${fd}`);
          supported = true;
        } finally {
          closeSync(fd);
        }
      } catch {
        // no usable /proc
      }
    }
  }
  return supported;
}

/**
 * Run `fn` with every helper read under `rootReal` (a real path: no symlink in it) contained in
 * that folder. `aliases` are other spellings of the same folder (the path callers were given, before
 * realpath); paths under them are contained the same way. Throws ContainmentUnavailable when the
 * platform cannot enforce it, or when any read in `fn` met a symlinked folder. Re-entrant for the
 * same root.
 */
export function withContainedReads<T>(rootReal: string, fn: () => T, aliases: string[] = []): T {
  if (scope) {
    if (scope.root === resolve(rootReal)) return fn();
    throw new ContainmentUnavailable("contained reads are already active for another checkout");
  }
  if (!containedReadsAvailable())
    throw new ContainmentUnavailable(
      "this platform has no descriptor-relative open (/proc/self/fd), so reads cannot be contained in the checkout",
    );
  let fd: number;
  try {
    fd = openSync(rootReal, OPEN_DIR);
  } catch (e) {
    throw new ContainmentUnavailable(`the checkout root cannot be opened (${(e as NodeJS.ErrnoException).code})`);
  }
  const root = resolve(rootReal);
  const s: Scope = { root, aliases: [...new Set(aliases.map((a) => resolve(a)))].filter((a) => a !== root), fd };
  scope = s;
  try {
    const out = fn();
    if (s.violation) throw new ContainmentUnavailable(s.violation);
    return out;
  } catch (e) {
    if (s.violation && !(e instanceof ContainmentUnavailable)) throw new ContainmentUnavailable(s.violation);
    throw e;
  } finally {
    scope = null;
    closeSync(fd);
  }
}

/** The root of the active contained scope, if any. */
export const containedRoot = (): string | null => scope?.root ?? null;

function errno(code: string, message: string): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

function violate(s: Scope, rel: string): never {
  const why = `${rel} is not a plain folder inside the checkout (a symlink was met during a contained read)`;
  s.violation ??= why;
  throw errno("ELOOP", why);
}

/**
 * For a path under the active root: its parent folder opened from the root descriptor (the caller
 * closes it when `owned`) and its last name ("." for the root itself). Null when no scope is active
 * or the path is outside the root, so the caller uses plain fs.
 */
function parentOf(p: string): { s: Scope; fd: number; owned: boolean; base: string; rel: string } | null {
  const s = scope;
  if (!s) return null;
  const abs = resolve(p);
  const under = (r: string) => abs === r || abs.startsWith(r + sep);
  const base = [s.root, ...s.aliases].find(under);
  if (base === undefined) return null;
  const rel = relative(base, abs);
  if (rel === "") return { s, fd: s.fd, owned: false, base: ".", rel: "." };
  const parts = rel.split(sep);
  let dir = s.fd;
  try {
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i] as string;
      let next: number;
      try {
        next = openSync(at(dir, name), OPEN_DIR);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ELOOP" || code === "ENOTDIR") {
          const l = lstatSync(at(dir, name), { throwIfNoEntry: false });
          if (l?.isSymbolicLink()) violate(s, parts.slice(0, i + 1).join("/"));
        }
        throw e;
      }
      if (dir !== s.fd) closeSync(dir);
      dir = next;
      containedTestHooks.afterDir?.(resolve(s.root, ...parts.slice(0, i + 1)));
    }
  } catch (e) {
    if (dir !== s.fd) closeSync(dir);
    throw e;
  }
  return { s, fd: dir, owned: dir !== s.fd, base: parts[parts.length - 1] as string, rel };
}

function withParent<T>(
  p: string,
  plain: () => T,
  contained: (path: string, q: NonNullable<ReturnType<typeof parentOf>>) => T,
): T {
  const q = parentOf(p);
  if (!q) return plain();
  try {
    return contained(at(q.fd, q.base), q);
  } finally {
    if (q.owned) closeSync(q.fd);
  }
}

/** lstat; null when the path (or a folder on it) does not exist. */
export function lstatContained(p: string): Stats | null {
  try {
    return withParent(
      p,
      () => lstatSync(p, { throwIfNoEntry: false }) ?? null,
      (path) => lstatSync(path, { throwIfNoEntry: false }) ?? null,
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

/** stat. In a scope a symlink is never followed: one at the end is a violation. */
export function statContained(p: string): Stats {
  return withParent(
    p,
    () => statSync(p),
    (path, q) => {
      const s = lstatSync(path);
      if (s.isSymbolicLink()) violate(q.s, q.rel);
      return s;
    },
  );
}

/** existsSync. In a scope a final symlink counts as present but is not followed. */
export function existsContained(p: string): boolean {
  try {
    return withParent(
      p,
      () => existsSync(p),
      (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw e;
  }
}

/** readdirSync names. In a scope the folder itself is opened without following a symlink. */
export function readdirContained(p: string): string[] {
  return withParent(
    p,
    () => readdirSync(p),
    (path, q) => {
      let fd: number;
      try {
        fd = openSync(path, OPEN_DIR);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if ((code === "ELOOP" || code === "ENOTDIR") && lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
          violate(q.s, q.rel);
        throw e;
      }
      try {
        return readdirSync(`${PROC_FD}/${fd}`);
      } finally {
        closeSync(fd);
      }
    },
  );
}

/** openSync for reading. In a scope: never through a symlink, never blocking, never for writing. */
export function openForRead(p: string, flags: number): number {
  containedTestHooks.beforeOpen?.(resolve(p));
  return withParent(
    p,
    () => openSync(p, flags),
    (path) => {
      if (flags & WRITE_FLAGS) throw errno("EPERM", `a contained read scope does not write (${p})`);
      return openSync(path, flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    },
  );
}

/** readlinkSync. */
export function readlinkContained(p: string): string {
  return withParent(
    p,
    () => readlinkSync(p),
    (path) => readlinkSync(path),
  );
}
