// Persistence safety: commit point, recovery after interrupted commits, retry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, ModelEngine, StoreError } from "../src/index.ts";
import type { CommitStep } from "../src/index.ts";
import { assertRev, baseModel, mcpAgent, owner, reviewer, timeoutChange } from "./helpers.ts";

const STEPS: CommitStep[] = [
  "revision.write",
  "revision.rename",
  "head.write",
  "head.rename",
  "change.write",
  "change.rename",
];
/** HEAD is the commit point: a crash before its rename leaves the old revision current. */
const committedIfCrashAt = (s: CommitStep) => s.startsWith("change.");

const freshDir = () => join(mkdtempSync(join(tmpdir(), "vcv-store-")), "store");

class Crash extends Error {}
const crashAt = (step: CommitStep) => ({
  beforeStep: (s: CommitStep) => {
    if (s === step) throw new Crash(`simulated crash before ${s}`);
  },
});

for (const step of STEPS) {
  test(`a direct commit interrupted before ${step} recovers to a consistent state and can be retried`, () => {
    const dir = freshDir();
    FileStore.init(dir, baseModel());
    const crashing = new ModelEngine(new FileStore(dir, crashAt(step)));
    assert.throws(() => crashing.propose(timeoutChange(), owner), Crash);

    const store = new FileStore(dir); // reopening runs recovery
    const e = new ModelEngine(store);
    assert.deepEqual(
      readdirSync(join(dir, "revisions")).filter((f) => f.includes(".tmp-")),
      [],
      "no temp files left",
    );
    assert.deepEqual(
      readdirSync(join(dir, "changes")).filter((f) => f.includes(".tmp-")),
      [],
    );

    if (committedIfCrashAt(step)) {
      assertRev(e.current().project.modelRevision, 2);
      assert.equal(store.revisions().length, 2);
      assertRev(store.revisions()[1], 2);
      const rec = e.record("ch-timeout-01")!;
      assert.equal(rec.status, "applied");
      assertRev(rec.resultingRevision, 2);
      assert.deepEqual(
        store.recovery.repairedChangeRecords,
        ["ch-timeout-01"],
        "the lost record was rebuilt from HEAD",
      );
      // A retry is recognised as a replay, not applied twice.
      assert.equal(e.propose(timeoutChange(), owner).diagnostics[0]!.code, "DUPLICATE_CHANGE");
    } else {
      assert.equal(e.current().project.modelRevision, "rev-1", "an incomplete commit is not visible");
      assert.deepEqual(store.revisions(), ["rev-1"]);
      assert.equal(e.record("ch-timeout-01"), undefined, "no record claims the change was applied");
      let leftover: string | undefined;
      if (step === "head.write" || step === "head.rename") {
        assert.equal(store.recovery.orphanedRevisions.length, 1);
        leftover = assertRev(store.recovery.orphanedRevisions[0], 2);
        assert.ok(
          existsSync(join(dir, "orphaned", `revision.${leftover}.yaml`)),
          "leftover kept for inspection, not deleted",
        );
      }
      // Safe retry: the same change now applies cleanly.
      const retry = e.propose(timeoutChange(), owner);
      assert.equal(retry.status, "applied");
      assertRev(retry.record!.resultingRevision, 2);
      if (leftover)
        assert.equal(retry.record!.resultingRevision, leftover, "same parent + same content = same revision ID");
    }

    // Whatever happened, a further reopen finds nothing to fix.
    const again = new FileStore(dir).recovery;
    assert.deepEqual(again, {
      removedTempFiles: [],
      orphanedRevisions: [],
      orphanedChangeRecords: [],
      repairedChangeRecords: [],
    });
  });
}

test("an approval interrupted after HEAD moved repairs the pending record to applied", () => {
  const dir = freshDir();
  FileStore.init(dir, baseModel());
  new ModelEngine(new FileStore(dir)).propose(timeoutChange(), mcpAgent);
  assert.throws(
    () => new ModelEngine(new FileStore(dir, crashAt("change.write"))).approve("ch-timeout-01", reviewer),
    Crash,
  );

  const e = new ModelEngine(new FileStore(dir));
  const rec = e.record("ch-timeout-01")!;
  assert.equal(rec.status, "applied");
  assert.equal(rec.approverId, "user:reviewer");
  assertRev(e.current().project.modelRevision, 2);
});

test("an approval interrupted before HEAD moved leaves the proposal pending and can be retried", () => {
  const dir = freshDir();
  FileStore.init(dir, baseModel());
  new ModelEngine(new FileStore(dir)).propose(timeoutChange(), mcpAgent);
  assert.throws(
    () => new ModelEngine(new FileStore(dir, crashAt("head.rename"))).approve("ch-timeout-01", reviewer),
    Crash,
  );

  const e = new ModelEngine(new FileStore(dir));
  assert.equal(e.record("ch-timeout-01")!.status, "pending");
  assert.equal(e.current().project.modelRevision, "rev-1");
  assert.equal(e.approve("ch-timeout-01", reviewer).status, "applied");
});

test("an applied record pointing at an uncommitted revision is moved aside", () => {
  const dir = freshDir();
  FileStore.init(dir, baseModel());
  writeFileSync(
    join(dir, "changes", "ch-ghost.json"),
    JSON.stringify({
      changeId: "ch-ghost",
      status: "applied",
      resultingRevision: "rev-9",
      projectId: "prj-lms",
      proposerId: "x",
      baseRevision: "rev-8",
      validationResults: [],
      change: {},
    }),
  );
  const store = new FileStore(dir);
  assert.deepEqual(store.recovery.orphanedChangeRecords, ["ch-ghost"]);
  assert.equal(store.getChange("ch-ghost"), undefined);
});

test("a corrupt or missing HEAD, or a missing committed revision, is a structured error", () => {
  const dir = freshDir();
  FileStore.init(dir, baseModel());
  writeFileSync(join(dir, "HEAD"), "{not json");
  assert.throws(
    () => new FileStore(dir),
    (e: unknown) => e instanceof StoreError && e.code === "CORRUPT",
  );

  const dir2 = freshDir();
  assert.throws(
    () => new FileStore(dir2),
    (e: unknown) => e instanceof StoreError && e.code === "NOT_INITIALIZED",
  );
  FileStore.init(dir2, baseModel());
  assert.throws(
    () => FileStore.init(dir2, baseModel()),
    (e: unknown) => e instanceof StoreError && e.code === "ALREADY_INITIALIZED",
  );
  writeFileSync(join(dir2, "HEAD"), JSON.stringify({ format: 1, revision: "rev-2", history: ["rev-1", "rev-2"] }));
  assert.throws(
    () => new FileStore(dir2),
    (e: unknown) => e instanceof StoreError && e.code === "CORRUPT",
  );
});

test("a torn final line in the audit log is skipped, earlier events survive", () => {
  const dir = freshDir();
  FileStore.init(dir, baseModel());
  const e = new ModelEngine(new FileStore(dir));
  e.propose(timeoutChange(), owner);
  appendFileSync(join(dir, "audit.jsonl"), '{"at":"2026-');
  const events = new FileStore(dir).audit();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.status, "applied");
  assert.ok(
    readFileSync(join(dir, "audit.jsonl"), "utf8").includes('{"at":"2026-'),
    "the log itself is never rewritten",
  );
});

test("after a crash leaves a torn audit line, new events are appended intact and stay visible", () => {
  const dir = freshDir();
  FileStore.init(dir, baseModel());
  new ModelEngine(new FileStore(dir)).propose(timeoutChange(), mcpAgent); // event 1: pending
  appendFileSync(join(dir, "audit.jsonl"), '{"at":"2026-11-10T15:00:00Z","action":"appr'); // crash mid-append

  // Recovery (reopen) followed by more activity.
  const e = new ModelEngine(new FileStore(dir));
  e.approve("ch-timeout-01", owner); // event 2: approved by someone other than the proposer
  e.propose(timeoutChange(), owner); // event 3: replay rejected

  const events = new FileStore(dir).audit();
  assert.deepEqual(
    events.map((a) => [a.action, a.status]),
    [
      ["propose", "pending"],
      ["approve", "applied"],
      ["propose", "rejected"],
    ],
    "no event after the torn line is lost",
  );
  const lines = readFileSync(join(dir, "audit.jsonl"), "utf8").split("\n");
  assert.equal(
    lines[1],
    '{"at":"2026-11-10T15:00:00Z","action":"appr',
    "the torn fragment is kept on its own line as evidence",
  );
  assert.equal(lines.at(-1), "", "the log ends with a newline");
});
