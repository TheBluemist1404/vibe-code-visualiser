import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, FileStoreReader, ModelEngine, StoreError } from "../src/index.ts";
import { assertRev, baseModel, owner, renamePending } from "./helpers.ts";

const newDir = () => join(mkdtempSync(join(tmpdir(), "vcv-reader-")), "store");

function fingerprint(dir: string): string {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [join(d, e.name) + "/", ...walk(join(d, e.name))] : [join(d, e.name)])).sort();
  return walk(dir).map((f) => (f.endsWith("/") ? f : `${f}:${statSync(f).mtimeMs}:${createHash("sha256").update(readFileSync(f)).digest("hex")}`)).join("\n");
}

test("FileStoreReader reads the committed head and follows commits made by another store", () => {
  const dir = newDir();
  FileStore.init(dir, baseModel());
  const reader = new FileStoreReader(dir);
  assert.equal(reader.current().project.modelRevision, "rev-1");

  const outcome = new ModelEngine(new FileStore(dir)).propose(renamePending("ch-rename-01"), owner);
  assert.equal(outcome.status, "applied");
  assertRev(reader.current().project.modelRevision, 2);
  assert.equal(reader.revisions().length, 2);

  // Callers get copies; mutating one cannot change what the next call returns.
  const m = reader.current();
  m.project.name = "changed by caller";
  assert.equal(reader.current().project.name, "LMS");
});

test("FileStoreReader never writes, not even the recovery FileStore would do", () => {
  const dir = newDir();
  FileStore.init(dir, baseModel());
  // Leave the kind of leftovers an interrupted commit produces; FileStore would move/delete them.
  writeFileSync(join(dir, "revisions", "rev-2.yaml"), "uncommitted\n");
  writeFileSync(join(dir, "HEAD.tmp-123"), "{}");
  const before = fingerprint(dir);

  const reader = new FileStoreReader(dir);
  reader.current();
  reader.revisions();
  assert.equal(fingerprint(dir), before);
  assert.equal(reader.current().project.modelRevision, "rev-1", "uncommitted revision files are ignored");
});

test("FileStoreReader fails clearly on missing or corrupt stores", () => {
  const empty = mkdtempSync(join(tmpdir(), "vcv-reader-empty-"));
  assert.throws(() => new FileStoreReader(empty), (e: unknown) => e instanceof StoreError && e.code === "NOT_INITIALIZED");
  assert.deepEqual(readdirSync(empty), []);

  const corrupt = newDir();
  mkdirSync(corrupt, { recursive: true });
  writeFileSync(join(corrupt, "HEAD"), "not json");
  assert.throws(() => new FileStoreReader(corrupt), (e: unknown) => e instanceof StoreError && e.code === "CORRUPT");

  const traversal = newDir();
  mkdirSync(traversal, { recursive: true });
  writeFileSync(join(traversal, "HEAD"), JSON.stringify({ format: 1, revision: "../../etc/x", history: ["../../etc/x"] }));
  assert.throws(() => new FileStoreReader(traversal), (e: unknown) => e instanceof StoreError && e.code === "CORRUPT" && /invalid revision ID/.test(e.message));

  const missingRev = newDir();
  FileStore.init(missingRev, baseModel());
  const reader = new FileStoreReader(missingRev);
  writeFileSync(join(missingRev, "HEAD"), JSON.stringify({ format: 1, revision: "rev-9", history: ["rev-1", "rev-9"] }));
  assert.throws(() => reader.current(), (e: unknown) => e instanceof StoreError && e.code === "CORRUPT" && /rev-9 is missing/.test(e.message));
});
