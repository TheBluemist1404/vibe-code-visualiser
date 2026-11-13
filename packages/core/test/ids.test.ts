// Identifier validation for everything the store turns into a file name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { checkModel, isPersistedId } from "@vcv/ir";
import { FileStore, MemoryStore, ModelEngine, StoreError, nextRevision } from "../src/index.ts";
import { baseModel, owner, renamePending, reviewer } from "./helpers.ts";
import { tempDir } from "@vcv/testkit";

const BAD = [
  "../HEAD",
  "a/b",
  "a\\b",
  "..",
  ".hidden",
  "",
  " rev-1",
  "rev 1",
  "rev-1.",
  "CON",
  "nul.json",
  "x".repeat(129),
  "ch:1",
  "ch\u0000",
  "ch-Test",
  "REV-1",
  "A1",
];
const GOOD = ["rev-1", "ch-timeout-01", "ch_2026.11.10", "a1", "ch-test", "x".repeat(128)];

test("the persisted-ID grammar accepts safe names and rejects path-like or reserved ones", () => {
  for (const id of GOOD) assert.ok(isPersistedId(id), `should accept ${JSON.stringify(id)}`);
  for (const id of BAD) assert.ok(!isPersistedId(id), `should reject ${JSON.stringify(id)}`);
  for (const rev of ["rev-1", "rev-99", "v7"])
    assert.ok(isPersistedId(nextRevision(rev)), "generated revisions stay valid");
});

test("a change with an unsafe changeId or expectedRevision is rejected with a structured error and writes nothing", () => {
  const root = tempDir("vcv-ids-");
  const dir = join(root, "store");
  FileStore.init(dir, baseModel());
  const e = new ModelEngine(new FileStore(dir));
  for (const bad of ["../../escape", "a/b", "CON"]) {
    const r = e.propose(renamePending(bad), owner);
    assert.equal(r.status, "rejected");
    assert.deepEqual(
      r.diagnostics.map((d) => [d.code, d.path]),
      [["SCHEMA", "changeId"]],
    );
    assert.equal(r.record, undefined);
    const stale = e.propose(renamePending(`ch-ok-${bad.length}`, bad), owner);
    assert.deepEqual(
      stale.diagnostics.map((d) => [d.code, d.path]),
      [["SCHEMA", "expectedRevision"]],
    );
  }
  assert.deepEqual(readdirSync(root), ["store"], "nothing was written outside the store");
  assert.deepEqual(readdirSync(join(dir, "changes")), []);
});

test("approving an unsafe or unknown change ID returns a structured result instead of throwing", () => {
  const e = new ModelEngine(new MemoryStore(baseModel()));
  const bad = e.approve("../HEAD", reviewer);
  assert.equal(bad.status, "rejected");
  assert.equal(bad.diagnostics[0]!.code, "INVALID_ID");
  assert.equal(e.approve("ch-missing", reviewer).diagnostics[0]!.code, "UNKNOWN_CHANGE");
  assert.equal(e.record("../HEAD"), undefined);
});

test("a model whose modelRevision is not a safe identifier fails validation and cannot initialize a store", () => {
  const m = baseModel();
  m.project.modelRevision = "../rev-1";
  const r = checkModel(m);
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.diagnostics.map((d) => [d.code, d.path]),
    [["SCHEMA", "project.modelRevision"]],
  );
  const dir = join(tempDir("vcv-ids-"), "store");
  assert.throws(
    () => FileStore.init(dir, m),
    (err: unknown) => err instanceof StoreError && err.code === "INVALID_ID",
  );
  assert.throws(
    () => new MemoryStore(m),
    (err: unknown) => err instanceof StoreError && err.code === "INVALID_ID",
  );
});

test("the store itself refuses unsafe IDs even if a caller skips the engine", () => {
  const dir = join(tempDir("vcv-ids-"), "store");
  const store = FileStore.init(dir, baseModel());
  assert.throws(
    () => store.getChange("../HEAD"),
    (err: unknown) => err instanceof StoreError && err.code === "INVALID_ID",
  );
});

test("IDs that differ only by case cannot both be persisted (case-insensitive filesystems)", () => {
  const dir = join(tempDir("vcv-ids-"), "store");
  FileStore.init(dir, baseModel());
  const e = new ModelEngine(new FileStore(dir));
  assert.equal(e.propose(renamePending("ch-test"), owner).status, "applied");

  // On Windows/macOS "ch-Test.json" would overwrite or alias "ch-test.json"; it is refused everywhere.
  const upper = e.propose(renamePending("ch-Test", "rev-2"), owner);
  assert.equal(upper.status, "rejected");
  assert.deepEqual(
    upper.diagnostics.map((d) => [d.code, d.path]),
    [["SCHEMA", "changeId"]],
  );
  assert.match(upper.diagnostics[0]!.message, /lowercase/);
  assert.equal(e.approve("CH-TEST", reviewer).diagnostics[0]!.code, "INVALID_ID");
  assert.deepEqual(readdirSync(join(dir, "changes")), ["ch-test.json"], "only the lowercase record exists");
  assert.equal(e.record("ch-test")!.proposerId, "user:hoang", "the original record is untouched");

  // Revision IDs follow the same rule.
  const m = baseModel();
  m.project.modelRevision = "Rev-1";
  assert.throws(
    () => new MemoryStore(m),
    (err: unknown) => err instanceof StoreError && err.code === "INVALID_ID",
  );
});
