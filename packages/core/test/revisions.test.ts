// Branch-safe revision identity and divergence detection (ADR 0007, Issue #6 M2.1 gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpModel, loadModel } from "@vcv/ir";
import {
  FileStore,
  FileStoreReader,
  ModelEngine,
  StoreError,
  branchSafeRevisionId,
  canonicalJson,
  inspectStore,
  isChildRevision,
  parseRevisionId,
  revisionDigest,
} from "../src/index.ts";
import { assertRev, baseModel, owner, renamePending, timeoutChange } from "./helpers.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "vcv-rev-"));
const storeErr = (code: string) => (err: unknown) => err instanceof StoreError && err.code === code;

/** One store, copied to two "branches" that then each commit a different change. */
function divergedPair() {
  const root = tmp();
  const base = join(root, "base");
  FileStore.init(base, baseModel());
  const a = join(root, "a");
  const b = join(root, "b");
  cpSync(base, a, { recursive: true });
  cpSync(base, b, { recursive: true });
  const ra = new ModelEngine(new FileStore(a)).propose(timeoutChange(), owner);
  const rb = new ModelEngine(new FileStore(b)).propose(renamePending("ch-rename-01"), owner);
  return { root, a, b, revA: ra.record!.resultingRevision!, revB: rb.record!.resultingRevision! };
}

test("two branches committing different changes after rev-1 get different revision IDs", () => {
  const { revA, revB } = divergedPair();
  assertRev(revA, 2);
  assertRev(revB, 2);
  assert.notEqual(revA, revB, "the old scheme would have named both rev-2");
});

test("the same change on the same parent yields the same ID (identical state, no false conflict)", () => {
  const root = tmp();
  const ids = ["x", "y"].map((n) => {
    const dir = join(root, n);
    FileStore.init(dir, baseModel());
    return new ModelEngine(new FileStore(dir)).propose(timeoutChange(), owner).record!.resultingRevision!;
  });
  assert.equal(ids[0], ids[1]);
  // And the committed files are byte-identical, so Git sees no conflict when both sides add them.
  const files = ["x", "y"].map((n) => readFileSync(join(root, n, "revisions", `${ids[0]}.yaml`), "utf8"));
  assert.equal(files[0], files[1]);
});

test("the digest covers parent and content, survives the YAML round trip, and is verifiable from the file", () => {
  const m = baseModel();
  const id = branchSafeRevisionId(m, "rev-1", 2);
  assert.deepEqual(parseRevisionId(id), { scheme: "branch-safe", seq: 2, digest: id.slice(-12) });
  assert.notEqual(revisionDigest(m, "rev-1"), revisionDigest(m, "rev-1b"), "parent is part of identity");
  const renamed = structuredClone(m);
  renamed.project.name = "LMS 2";
  assert.notEqual(revisionDigest(m, "rev-1"), revisionDigest(renamed, "rev-1"), "content is part of identity");

  // Written and read back (as recovery does), the file still verifies as that child.
  const written = structuredClone(m);
  written.project.modelRevision = id;
  const reread = loadModel(dumpModel(written)).model!;
  assert.ok(isChildRevision(id, reread, "rev-1", 2));
  assert.ok(!isChildRevision(id, reread, "rev-1", 3), "wrong position");
  assert.ok(!isChildRevision(id, reread, "rev-x", 2), "wrong parent");
  assert.ok(!isChildRevision("rev-2", reread, "rev-1", 2), "legacy IDs carry nothing to verify");
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
});

test("legacy sequential stores keep working and continue with branch-safe IDs", () => {
  const dir = join(tmp(), "store");
  FileStore.init(dir, baseModel());
  // Simulate a pre-M2 store that already reached rev-2 with the sequential scheme.
  const legacy = baseModel();
  legacy.project.modelRevision = "rev-2";
  legacy.project.name = "LMS (legacy rev-2)";
  writeFileSync(join(dir, "revisions", "rev-2.yaml"), dumpModel(legacy));
  writeFileSync(join(dir, "HEAD"), JSON.stringify({ format: 1, revision: "rev-2", history: ["rev-1", "rev-2"] }, null, 2) + "\n");

  const e = new ModelEngine(new FileStore(dir));
  assert.equal(e.current().project.modelRevision, "rev-2");
  const r = e.propose(renamePending("ch-after-legacy", "rev-2"), owner);
  assert.equal(r.status, "applied");
  assertRev(r.record!.resultingRevision, 3);
  assert.deepEqual(new FileStore(dir).revisions().slice(0, 2), ["rev-1", "rev-2"], "old history is untouched");
});

test("Git conflict markers in HEAD are reported as CONFLICTED by writer, reader and inspection", () => {
  const { a, revA, revB } = divergedPair();
  // What `git merge` leaves when both branches moved .vcv/HEAD.
  writeFileSync(
    join(a, "HEAD"),
    `{\n  "format": 1,\n<<<<<<< HEAD\n  "revision": "${revA}",\n=======\n  "revision": "${revB}",\n>>>>>>> b\n}\n`,
  );
  assert.throws(() => new FileStore(a), storeErr("CONFLICTED"));
  assert.throws(() => new FileStoreReader(a), storeErr("CONFLICTED"));
  const inspected = inspectStore(a);
  assert.equal(inspected.state, "conflicted");
  assert.deepEqual(inspected.state === "conflicted" && inspected.files, ["HEAD"]);
});

test("a merge resolved to one side's HEAD leaves foreign revisions: DIVERGED, and nothing is moved", () => {
  const { a, b, revA, revB } = divergedPair();
  // Bring branch B's revision file into A (as a merge that kept A's HEAD would).
  cpSync(join(b, "revisions", `${revB}.yaml`), join(a, "revisions", `${revB}.yaml`));
  const before = readdirSync(join(a, "revisions")).sort();

  assert.throws(() => new FileStore(a), (err: unknown) => storeErr("DIVERGED")(err) && (err as Error).message.includes(revB));
  assert.deepEqual(readdirSync(join(a, "revisions")).sort(), before, "recovery did not orphan the other branch's revision");
  assert.ok(!existsSync(join(a, "orphaned", `revision.${revB}.yaml`)));

  const inspected = inspectStore(a);
  assert.equal(inspected.state, "diverged");
  if (inspected.state === "diverged") {
    assert.equal(inspected.revision, revA);
    assert.deepEqual(inspected.foreign.map((f) => f.id), [revB]);
  }
  // The read-only reader still serves HEAD's own line (it never reads unlisted files).
  assert.equal(new FileStoreReader(a).current().project.modelRevision, revA);
});

test("an interrupted commit is still recognised as a leftover and moved aside", () => {
  const dir = join(tmp(), "store");
  FileStore.init(dir, baseModel());
  // The file an interrupted commit leaves: the next child of HEAD, not listed in HEAD.
  const child = baseModel();
  child.project.name = "LMS next";
  const id = branchSafeRevisionId(child, "rev-1", 2);
  child.project.modelRevision = id;
  writeFileSync(join(dir, "revisions", `${id}.yaml`), dumpModel(child));

  const inspected = inspectStore(dir);
  assert.equal(inspected.state, "ok");
  assert.deepEqual(inspected.state === "ok" && inspected.leftovers.map((l) => l.id), [id]);
  const store = new FileStore(dir);
  assert.deepEqual(store.recovery.orphanedRevisions, [id]);
});

test("inspectStore distinguishes absent, uninitialized and invalid stores without writing", () => {
  const root = tmp();
  assert.equal(inspectStore(join(root, "missing")).state, "absent");
  assert.ok(!existsSync(join(root, "missing")));
  const empty = join(root, "empty");
  mkdirSync(empty);
  assert.equal(inspectStore(empty).state, "uninitialized");
  const broken = join(root, "broken");
  FileStore.init(broken, baseModel());
  writeFileSync(join(broken, "HEAD"), "{ not json");
  const r = inspectStore(broken);
  assert.equal(r.state, "invalid");
});
