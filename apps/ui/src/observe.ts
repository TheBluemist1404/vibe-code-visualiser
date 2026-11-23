// One identity for "the checkout as a read saw it" (Issue #44 review): the model identity, Git
// commit, branch and dirty state, every byte under .vcv/ except the local cache/ (HEAD, revisions,
// change records, attestations, the trust list, bindings, implementation reports), and, when the
// host was given one, the commit a named ref resolves to. Two observations that differ in any of
// these are different states, even under the same revision ID.
//
// An answer built from several reads is served only if the identity taken before the first read
// equals the one taken after the last; otherwise the reads are retried, and a checkout that keeps
// moving is STATE_CHANGED. Nothing is stitched together from two states.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { projectStatus } from "@vcv/repo";
import { StateChangedError, modelKey } from "./session.ts";

const MAX_FILES = 5000;
const MAX_BYTES = 64 * 1024 * 1024;
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
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      h.update(`\0missing:${rel}`);
      return;
    }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      if (r === "cache") continue; // the writer lock and other local state
      const p = join(dir, n);
      const s = lstatSync(p, { throwIfNoEntry: false });
      if (!s) continue;
      if (s.isDirectory()) walk(p, r);
      else {
        files += 1;
        bytes += s.size;
        if (files > MAX_FILES || bytes > MAX_BYTES) {
          h.update(`\0over-budget:${r}:${s.size}:${s.mtimeMs}`);
          continue;
        }
        h.update(`\0${r}\0`);
        h.update(s.isFile() ? readFileSync(p) : `link:${s.size}`);
      }
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
  if (entries.length > SOURCE_MAX_FILES)
    throw new ObservationLimit(
      `${entries.length} changed or untracked files is more than this view checks (${SOURCE_MAX_FILES}); commit or clean some and retry`,
    );
  let bytes = 0;
  h.update("\0source");
  for (const e of entries.sort()) {
    const rel = e.slice(3);
    h.update(`\0${e}\0`);
    const s = lstatSync(join(root, rel), { throwIfNoEntry: false });
    if (!s) {
      h.update("deleted");
      continue;
    }
    if (s.isDirectory()) {
      h.update("dir");
      continue;
    }
    if (!s.isFile()) {
      h.update(`special:${s.size}`);
      continue;
    }
    bytes += s.size;
    if (bytes > SOURCE_MAX_BYTES)
      throw new ObservationLimit(
        `changed or untracked files add up to more than ${SOURCE_MAX_BYTES} bytes; this view cannot observe them consistently`,
      );
    try {
      h.update(readFileSync(join(root, rel)));
    } catch (err) {
      throw new ObservationLimit(`cannot read ${rel}: ${(err as Error).message}`);
    }
  }
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
