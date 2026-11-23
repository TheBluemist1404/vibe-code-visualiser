// Writer serialization across processes (Issue #43): real Node processes racing the engine's
// propose/approve paths on one FileStore, crash injection, and the lock's own rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tempDir } from "@vcv/testkit";
import {
  FileStore,
  LOCK_FILE,
  ModelEngine,
  inspectStore,
  proposalDigest,
  readLockOwner,
  storeFingerprint,
  withStoreLock,
} from "../src/index.ts";
import type { ChangeRecord, CommitStep, HostContext, ProposedModelChange } from "../src/index.ts";
import { baseModel, mcpAgent, owner, reviewer } from "./helpers.ts";

const WORKER = join(import.meta.dirname, "workers", "store-writer.ts");
const freshStore = () => {
  const dir = join(tempDir("vcv-lock-"), "store");
  FileStore.init(dir, baseModel());
  return dir;
};
const rename = (changeId: string, name: string, expectedRevision = "rev-1"): ProposedModelChange => ({
  changeId,
  projectId: "prj-lms",
  expectedRevision,
  operations: [{ type: "renameState", behaviorId: "beh-enrollment-approval", stateId: "st-pending", name }],
});

type Line = Record<string, unknown>;
type Worker = {
  ready: Promise<void>;
  done: Promise<{ code: number | null; lines: Line[] }>;
  pid: number;
  kill(): void;
};

function worker(task: Record<string, unknown>, onLine?: (l: Line) => void): Worker {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", WORKER, JSON.stringify(task)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Line[] = [];
  let buf = "";
  let err = "";
  let ready!: () => void;
  const readyP = new Promise<void>((r) => {
    ready = r;
  });
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const l = JSON.parse(buf.slice(0, i)) as Line;
      buf = buf.slice(i + 1);
      lines.push(l);
      if (l.ready) ready();
      onLine?.(l);
    }
  });
  child.stderr.on("data", (d: Buffer) => {
    err += d.toString();
  });
  const done = new Promise<{ code: number | null; lines: Line[] }>((resolve) =>
    child.on("close", (code) => {
      if (err && code === 0) process.stderr.write(err);
      ready();
      resolve({ code, lines });
    }),
  );
  return { ready: readyP, done, pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

/** Start every task as its own process, release them together, and return each one's final line. */
async function race(tasks: Record<string, unknown>[]): Promise<Line[]> {
  const barrier = join(tempDir("vcv-barrier-"), "go");
  const ws = tasks.map((t) => worker({ ...t, barrier }));
  await Promise.all(ws.map((w) => w.ready));
  writeFileSync(barrier, "");
  const results = await Promise.all(ws.map((w) => w.done));
  return results.map((r) => r.lines.at(-1)!);
}

const records = (dir: string): ChangeRecord[] =>
  readdirSync(join(dir, "changes"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, "changes", f), "utf8")) as ChangeRecord);
const head = (dir: string) => JSON.parse(readFileSync(join(dir, "HEAD"), "utf8")) as { history: string[] };
const lockFree = (dir: string) => !existsSync(join(dir, LOCK_FILE));
const assertHealthy = (dir: string) => {
  const r = inspectStore(dir);
  assert.equal(r.state, "ok", JSON.stringify(r));
};

test("propose vs propose: N processes applying different changes on the same base revision; exactly one wins, the rest are stale, nothing is lost", async () => {
  const dir = freshStore();
  const n = 5;
  const out = await race(
    Array.from({ length: n }, (_, i) => ({
      dir,
      action: "propose",
      ctx: owner,
      change: rename(`chg-${i}`, `Waiting ${i}`),
    })),
  );
  const applied = out.filter((o) => o.status === "applied");
  assert.equal(applied.length, 1, JSON.stringify(out));
  for (const o of out.filter((o) => o.status !== "applied")) {
    assert.equal(o.status, "rejected");
    assert.deepEqual(o.codes, ["STALE_REVISION"], JSON.stringify(o));
  }
  assert.deepEqual(head(dir).history, ["rev-1", applied[0]!.resultingRevision]);
  assert.equal(readdirSync(join(dir, "revisions")).length, 2, "no extra revision file");
  // Every contender left exactly one record, none overwritten, the winner's points at HEAD.
  const recs = records(dir);
  assert.equal(recs.length, n);
  assert.equal(recs.filter((r) => r.status === "applied").length, 1);
  assert.equal(recs.find((r) => r.status === "applied")!.changeId, applied[0]!.changeId);
  assert.equal(new FileStore(dir).audit().length, n, "every attempt audited");
  assertHealthy(dir);
  assert.ok(lockFree(dir), "lock released");
});

test("a writer holding the lock mid-commit is waited for: the second process neither orphans the first one's new revision nor validates against the old HEAD", async () => {
  const dir = freshStore();
  const barrier = join(tempDir("vcv-barrier-"), "go");
  let paused!: () => void;
  const pausedP = new Promise<void>((r) => {
    paused = r;
  });
  // A writes its revision file, then stops before HEAD for 600 ms, holding the lock.
  const a = worker(
    { dir, action: "propose", ctx: owner, change: rename("chg-a", "A"), pauseAt: { step: "head.write", ms: 600 } },
    (l) => l.paused && paused(),
  );
  await pausedP;
  // B opens the store now (recovery would otherwise move A's revision aside) and proposes.
  const b = worker({ dir, action: "propose", ctx: owner, change: rename("chg-b", "B"), barrier });
  await b.ready;
  writeFileSync(barrier, "");
  const [ra, rb] = await Promise.all([a.done, b.done]);
  const la = ra.lines.at(-1)!;
  const lb = rb.lines.at(-1)!;
  assert.equal(la.status, "applied", JSON.stringify(la));
  assert.equal(lb.status, "rejected");
  assert.deepEqual(lb.codes, ["STALE_REVISION"], "B decided on A's committed state");
  assert.deepEqual(head(dir).history, ["rev-1", la.resultingRevision]);
  assert.deepEqual(readdirSync(join(dir, "orphaned")), [], "nothing moved aside");
  assertHealthy(dir);
});

test("pending proposals with distinct IDs from concurrent processes all persist intact; one ID submitted by several processes is recorded once, never overwritten", async () => {
  const dir = freshStore();
  const distinct = await race(
    Array.from({ length: 6 }, (_, i) => ({
      dir,
      action: "propose",
      ctx: mcpAgent,
      change: rename(`pend-${i}`, `Pending ${i}`),
    })),
  );
  assert.ok(
    distinct.every((o) => o.status === "pending"),
    JSON.stringify(distinct),
  );
  const recs = records(dir);
  assert.deepEqual(
    recs.map((r) => r.changeId).sort(),
    [0, 1, 2, 3, 4, 5].map((i) => `pend-${i}`),
  );
  for (const r of recs) assert.equal(r.change.operations[0]!.type, "renameState");

  const variants = [0, 1, 2, 3].map((i) => rename("same-id", `Variant ${i}`));
  const same = await race(variants.map((change) => ({ dir, action: "propose", ctx: mcpAgent, change })));
  const won = same.filter((o) => o.status === "pending");
  assert.equal(won.length, 1, JSON.stringify(same));
  for (const o of same.filter((o) => o.status !== "pending")) assert.deepEqual(o.codes, ["DUPLICATE_CHANGE"]);
  const onDisk = records(dir).find((r) => r.changeId === "same-id")!;
  const digests = variants.map(proposalDigest);
  assert.ok(digests.includes(proposalDigest(onDisk.change)), "the record is one submitted variant, whole");
  assert.deepEqual(head(dir).history, ["rev-1"], "no proposal moved HEAD");
  assertHealthy(dir);
});

test("approve vs approve: two reviewer processes approving one pending change; one applies it, the other gets NOT_PENDING", async () => {
  const dir = freshStore();
  const e = new ModelEngine(new FileStore(dir));
  assert.equal(e.propose(rename("chg-p", "Reviewed"), mcpAgent).status, "pending");
  const other: HostContext = { principalId: "user:second-reviewer", permissions: ["model:approve"] };
  const out = await race([
    { dir, action: "approve", ctx: reviewer, changeId: "chg-p" },
    { dir, action: "approve", ctx: other, changeId: "chg-p" },
  ]);
  assert.equal(out.filter((o) => o.status === "applied").length, 1, JSON.stringify(out));
  const loser = out.find((o) => o.status !== "applied")!;
  assert.deepEqual(loser.codes, ["NOT_PENDING"]);
  const rec = new FileStore(dir).getChange("chg-p")!;
  assert.equal(rec.status, "applied");
  assert.equal(head(dir).history.length, 2);
  assert.equal(rec.resultingRevision, head(dir).history[1]);
  assertHealthy(dir);
});

test("approve vs submit-and-apply on the same base: exactly one lands; the other is a deterministic STALE_REVISION and keeps its own record", async () => {
  for (let round = 0; round < 3; round++) {
    const dir = freshStore();
    const e = new ModelEngine(new FileStore(dir));
    assert.equal(e.propose(rename("chg-p", "From review"), mcpAgent).status, "pending");
    const [ap, sub] = await race([
      { dir, action: "approve", ctx: reviewer, changeId: "chg-p" },
      { dir, action: "propose", ctx: owner, change: rename("chg-q", "Direct") },
    ]);
    const statuses = [ap!.status, sub!.status].sort();
    assert.deepEqual(statuses, ["applied", "rejected"], JSON.stringify([ap, sub]));
    const lost = ap!.status === "rejected" ? ap! : sub!;
    assert.deepEqual(lost.codes, ["STALE_REVISION"]);
    const recs = new Map(records(dir).map((r) => [r.changeId, r]));
    assert.equal(recs.size, 2, "both changes keep a record");
    assert.equal([...recs.values()].filter((r) => r.status === "applied").length, 1);
    assert.equal(head(dir).history.length, 2);
    assertHealthy(dir);
  }
});

const STEPS: CommitStep[] = ["revision.rename", "head.write", "head.rename", "change.write", "change.rename"];
for (const step of STEPS) {
  test(`a writer process dying at ${step} leaves no wedge: the lock is broken (dead PID), the store recovers, and the next write lands`, async () => {
    const dir = freshStore();
    const r = await worker({ dir, action: "propose", ctx: owner, change: rename("chg-crash", "Crash"), crashAt: step })
      .done;
    assert.equal(r.code, 137, "the worker died mid-commit");
    assert.ok(!lockFree(dir), "its lock file is left behind");
    // A new process opens the store: breaks the dead holder's lock and runs recovery.
    const next = await worker({
      dir,
      action: "propose",
      ctx: owner,
      change: rename("chg-next", "Next"),
      timeoutMs: 5000,
    }).done;
    const l = next.lines.at(-1)!;
    const committed = step === "change.write" || step === "change.rename"; // HEAD already named it
    if (committed) {
      assert.deepEqual(l.codes, ["STALE_REVISION"], "the crashed change was committed; next is stale");
      assert.equal(new FileStore(dir).getChange("chg-crash")?.status, "applied", "record repaired from HEAD");
    } else {
      assert.equal(l.status, "applied", JSON.stringify(l));
      assert.equal(new FileStore(dir).getChange("chg-crash"), undefined);
    }
    assert.ok(lockFree(dir));
    assertHealthy(dir);
  });
}

test("a writer killed with SIGKILL while holding the lock does not wedge the store", async () => {
  const dir = freshStore();
  let held!: () => void;
  const heldP = new Promise<void>((r) => {
    held = r;
  });
  const w = worker({ dir, action: "hold", holdMs: 60_000 }, (l) => l.held && held());
  await heldP;
  assert.equal(readLockOwner(dir)?.pid, w.pid);
  w.kill();
  await w.done;
  const e = new ModelEngine(new FileStore(dir, { lock: { timeoutMs: 5000 } }));
  assert.equal(e.propose(rename("chg-after", "After"), owner).status, "applied");
  assert.ok(lockFree(dir));
});

test("a live holder is never stolen: a waiting writer times out with LOCKED naming the holder, and nothing is written", async () => {
  const dir = freshStore();
  let held!: () => void;
  const heldP = new Promise<void>((r) => {
    held = r;
  });
  const w = worker({ dir, action: "hold", holdMs: 3000 }, (l) => l.held && held());
  await heldP;
  const before = storeFingerprint(dir);
  assert.throws(
    () => withStoreLock(dir, () => assert.fail("must not run"), { timeoutMs: 300 }),
    (e: { code: string; message: string }) => {
      assert.equal(e.code, "LOCKED");
      assert.match(e.message, new RegExp(`pid ${w.pid}`));
      assert.match(e.message, /test hold/);
      return true;
    },
  );
  assert.equal(readLockOwner(dir)?.pid, w.pid, "still the live holder's lock");
  // The engine surfaces the same refusal; nothing reaches the store files.
  assert.throws(() => new FileStore(dir, { lock: { timeoutMs: 200 } }), { code: "LOCKED" });
  assert.equal(storeFingerprint(dir), before);
  const r = await w.done;
  assert.equal(r.lines.at(-1)!.released, true);
  assert.ok(lockFree(dir));
});

test("lock rules: reentrant in one thread; another host's lock is never broken; an unreadable lock is broken only once old; release never removes a lock it does not own", () => {
  const dir = freshStore();
  const lock = join(dir, LOCK_FILE);
  // Reentrant: the engine inside a held lock just runs.
  withStoreLock(dir, () => {
    const e = new ModelEngine(new FileStore(dir));
    assert.equal(e.propose(rename("chg-r", "Re"), owner).status, "applied");
    assert.ok(existsSync(lock));
  });
  assert.ok(!existsSync(lock));

  const foreign = {
    format: 1,
    token: "x",
    pid: 1,
    thread: 0,
    host: `${hostname()}-elsewhere`,
    acquiredAt: "",
    purpose: "remote",
  };
  writeFileSync(lock, JSON.stringify(foreign));
  assert.throws(() => withStoreLock(dir, () => 0, { timeoutMs: 100 }), { code: "LOCKED" });
  assert.equal(readLockOwner(dir)?.host, foreign.host, "left for a person");

  writeFileSync(lock, "torn"); // fresh and unreadable: may be in the middle of being written
  assert.throws(() => withStoreLock(dir, () => 0, { timeoutMs: 100 }), { code: "LOCKED" });
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(
    withStoreLock(dir, () => 7, { timeoutMs: 1000 }),
    7,
  );

  // If the lock is replaced while held (by hand), release leaves the replacement alone.
  withStoreLock(dir, () => {
    rmSync(lock);
    writeFileSync(lock, JSON.stringify({ ...foreign, token: "someone-else" }));
  });
  assert.equal(readLockOwner(dir)?.token, "someone-else");
  rmSync(lock);
});

test("the lock refuses a symlinked cache/ and never follows it; taking the lock does not change the store fingerprint", () => {
  const dir = freshStore();
  const fp = storeFingerprint(dir);
  withStoreLock(dir, () => assert.equal(storeFingerprint(dir), fp, "cache/ is not fingerprinted"));
  rmSync(join(dir, "cache"), { recursive: true });
  const elsewhere = tempDir("vcv-elsewhere-");
  symlinkSync(elsewhere, join(dir, "cache"));
  assert.throws(() => withStoreLock(dir, () => 0), { code: "UNSAFE_LOCK" });
  assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");
});

test("a branch swap while a writer validates (lock held) is still refused by the store's rechecks: no write lands on the unintended line", () => {
  const root = tempDir("vcv-swap-");
  const base = join(root, "base");
  FileStore.init(base, baseModel());
  const other = join(root, "other");
  cpSync(base, other, { recursive: true });
  assert.equal(
    new ModelEngine(new FileStore(other)).propose(rename("chg-other", "Other line"), owner).status,
    "applied",
  );
  const otherHead = readFileSync(join(other, "HEAD"), "utf8");

  // The swap (an external `git checkout`, which does not take the VCV lock) lands after the
  // engine's snapshot, inside the locked decision.
  class SwappingStore extends FileStore {
    swapped = false;
    override snapshot() {
      const s = super.snapshot();
      if (!this.swapped) {
        this.swapped = true;
        for (const sub of ["revisions", "changes"]) {
          rmSync(join(base, sub), { recursive: true });
          cpSync(join(other, sub), join(base, sub), { recursive: true });
        }
        cpSync(join(other, "HEAD"), join(base, "HEAD"));
      }
      return s;
    }
  }
  const e = new ModelEngine(new SwappingStore(base));
  const r = e.propose(rename("chg-mine", "Mine"), owner);
  assert.equal(r.status, "rejected");
  assert.ok(["HEAD_CHANGED", "STORE_CHANGED"].includes(r.diagnostics[0]!.code), r.diagnostics[0]!.code);
  assert.equal(readFileSync(join(base, "HEAD"), "utf8"), otherHead, "the other line's HEAD is untouched");
  assert.equal(readdirSync(join(base, "revisions")).length, 2, "no revision written");
  assert.ok(lockFree(base));
});
