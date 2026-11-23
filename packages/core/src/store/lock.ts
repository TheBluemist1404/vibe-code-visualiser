// The per-store writer lock (Issue #43, docs/adr/0010-writer-lock.md).
//
// Every VCV process that writes a store (CLI, MCP, the repo adapter, a future UI host) runs its
// decisive read/check/write phase inside withStoreLock(storeDir, ...). The lock is a file,
// `<storeDir>/cache/writer.lock`, created with an exclusive hard link from a fully written temp
// file, so it either does not exist or holds a complete owner record. `cache/` is local state:
// ignored by `.vcv/.gitignore` and not part of storeFingerprint(), so taking the lock never
// changes Git status or what a reader sees.
//
// It only serializes cooperating VCV writers. A `git checkout`, an editor or any other process
// that does not take the lock is not held back; the store's HEAD_CHANGED/STORE_CHANGED rechecks,
// run after the lock is taken, are what detect those.
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { threadId } from "node:worker_threads";
import { StoreError } from "./files.ts";

export const LOCK_FILE = "cache/writer.lock";

/** Who holds a lock. Written once, when the lock is created; never updated. */
export type LockOwner = {
  format: 1;
  token: string;
  pid: number;
  thread: number;
  host: string;
  /** Linux boot ID when available, so a lock left by an earlier boot is never mistaken for a live one. */
  boot?: string;
  acquiredAt: string;
  purpose: string;
};

export type LockOptions = {
  /** What the holder is doing, shown to a waiting writer (e.g. "approve chg-1"). */
  purpose?: string;
  /** Give up with LOCKED after this long. Default VCV_LOCK_TIMEOUT_MS or 30 s. */
  timeoutMs?: number;
  /** Test hook: called once per wait round with the current holder (null if unreadable). */
  onWait?: (holder: LockOwner | null) => void;
};

/** A lock file whose owner cannot be read is assumed to be a torn write after this long. */
const UNREADABLE_GRACE_MS = 10_000;
/** The break guard is held for a few file operations; one older than this was left by a crash. */
const BREAK_GUARD_STALE_MS = 30_000;

type Held = { token: string; depth: number };
// Per process, shared by every copy of this module (several import paths can load it twice).
const HELD: Map<string, Held> = (() => {
  const g = globalThis as Record<symbol, unknown>;
  const k = Symbol.for("vcv.storeLocks");
  if (!(g[k] instanceof Map)) g[k] = new Map<string, Held>();
  return g[k] as Map<string, Held>;
})();

/**
 * Run `fn` while holding the writer lock of the store at `storeDir`. Reentrant within a thread, so
 * an engine call inside a repo operation that already holds the lock just runs. `fn` must be
 * synchronous: the lock is released when it returns or throws.
 */
export function withStoreLock<T>(storeDir: string, fn: () => T, opts: LockOptions = {}): T {
  const key = lockKey(storeDir);
  const mine = HELD.get(key);
  if (mine) {
    mine.depth++;
    try {
      return fn();
    } finally {
      mine.depth--;
    }
  }
  const token = acquire(storeDir, opts);
  HELD.set(key, { token, depth: 1 });
  try {
    const out = fn();
    if (out instanceof Promise) throw new Error("withStoreLock: fn must be synchronous");
    return out;
  } finally {
    HELD.delete(key);
    release(storeDir, token);
  }
}

/** True if this thread currently holds the lock for `storeDir`. */
export function holdsStoreLock(storeDir: string): boolean {
  return HELD.has(lockKey(storeDir));
}

/** The current holder of a store's lock as recorded on disk, or null if it is free or unreadable. */
export function readLockOwner(storeDir: string): LockOwner | null {
  return parseOwner(readOrNull(join(storeDir, LOCK_FILE)));
}

function acquire(storeDir: string, opts: LockOptions): string {
  const dir = cacheDir(storeDir);
  const lockPath = join(dir, "writer.lock");
  const owner: LockOwner = {
    format: 1,
    token: randomBytes(12).toString("hex"),
    pid: process.pid,
    thread: threadId,
    host: hostname(),
    ...(BOOT_ID ? { boot: BOOT_ID } : {}),
    acquiredAt: new Date().toISOString(),
    purpose: opts.purpose ?? "write",
  };
  const timeout = opts.timeoutMs ?? envTimeout() ?? 30_000;
  const deadline = Date.now() + timeout;
  let delay = 2;
  for (;;) {
    if (tryCreate(lockPath, `${JSON.stringify(owner)}\n`)) return owner.token;
    const text = readOrNull(lockPath);
    if (text === null) continue; // released between our attempt and the read: try again now
    const holder = parseOwner(text);
    if (isStale(holder, lockPath)) {
      breakStale(dir, lockPath, text);
      continue;
    }
    opts.onWait?.(holder);
    if (Date.now() >= deadline) {
      throw new StoreError(
        "LOCKED",
        `another VCV writer holds ${storeDir}/${LOCK_FILE}${holder ? ` (${describe(holder)})` : ""}; waited ${timeout} ms, nothing was written. Retry when it finishes. If no VCV process is running, delete that file.`,
      );
    }
    sleep(Math.min(delay, Math.max(1, deadline - Date.now())) + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, 100);
  }
}

function release(storeDir: string, token: string): void {
  const lockPath = join(storeDir, LOCK_FILE);
  const holder = parseOwner(readOrNull(lockPath));
  // Never delete a lock that is not ours (it was judged stale and taken over, or replaced by hand).
  if (holder?.token !== token) return;
  try {
    unlinkSync(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * A holder is stale only when it provably cannot be running: same host and (earlier boot, or a
 * process that no longer exists, or this very thread without the lock in its table). A lock from
 * another host is never broken automatically. An unreadable lock file (impossible from VCV itself,
 * since the owner is written before the link) is broken only once it is old.
 */
function isStale(holder: LockOwner | null, lockPath: string): boolean {
  if (!holder) return ageMs(lockPath) > UNREADABLE_GRACE_MS;
  if (holder.host !== hostname()) return false;
  if (holder.boot && BOOT_ID && holder.boot !== BOOT_ID) return true;
  if (holder.pid === process.pid) return holder.thread === threadId; // this thread holds nothing (checked by caller)
  return !pidAlive(holder.pid);
}

/**
 * Remove a stale lock without racing another breaker: under a short-lived break guard, the lock
 * is renamed aside and only discarded if it is still exactly the stale file that was judged; if a
 * live writer's lock was moved by mistake it is put back.
 */
function breakStale(dir: string, lockPath: string, judged: string): void {
  const guard = join(dir, "writer.lock.break");
  if (!tryCreate(guard, `${process.pid}\n`)) {
    if (ageMs(guard) > BREAK_GUARD_STALE_MS) rmQuiet(guard);
    else sleep(5);
    return;
  }
  try {
    const aside = `${lockPath}.stale-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(lockPath, aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (readOrNull(aside) === judged) {
      rmQuiet(aside);
      return;
    }
    try {
      linkSync(aside, lockPath); // not the file we judged: restore it
    } catch {
      // someone took the free lock in between; the moved lock's owner will find it is no longer theirs
    }
    rmQuiet(aside);
  } finally {
    rmQuiet(guard);
  }
}

/** Exclusive create with complete content: write a temp file, then hard-link it into place. */
function tryCreate(path: string, text: string): boolean {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    rmQuiet(tmp);
  }
}

function cacheDir(storeDir: string): string {
  const dir = join(storeDir, "cache");
  let st = lstatOrNull(dir);
  if (!st) {
    mkdirSync(dir, { recursive: true });
    st = lstatOrNull(dir);
  }
  if (!st || st.isSymbolicLink() || !st.isDirectory())
    throw new StoreError("UNSAFE_LOCK", `${dir} is not a plain directory; nothing was written`);
  const lock = lstatOrNull(join(dir, "writer.lock"));
  if (lock && (lock.isSymbolicLink() || !lock.isFile()))
    throw new StoreError("UNSAFE_LOCK", `${dir}/writer.lock is not a regular file; nothing was written`);
  return dir;
}

function lockKey(storeDir: string): string {
  try {
    return `${realpathSync(storeDir)}\0${threadId}`;
  } catch {
    return `${storeDir}\0${threadId}`;
  }
}

function parseOwner(text: string | null): LockOwner | null {
  if (!text) return null;
  try {
    const o = JSON.parse(text) as LockOwner;
    return o?.format === 1 && typeof o.token === "string" && typeof o.pid === "number" && typeof o.host === "string"
      ? o
      : null;
  } catch {
    return null;
  }
}

function describe(o: LockOwner): string {
  return `pid ${o.pid} on ${o.host} since ${o.acquiredAt}, ${o.purpose}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function ageMs(path: string): number {
  const st = lstatOrNull(path);
  return st ? Date.now() - st.mtimeMs : 0;
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function rmQuiet(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function envTimeout(): number | undefined {
  const v = Number(process.env.VCV_LOCK_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number) {
  Atomics.wait(SLEEPER, 0, 0, ms);
}

const BOOT_ID = (() => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
})();
