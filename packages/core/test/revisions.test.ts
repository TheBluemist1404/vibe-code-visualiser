// Branch-safe revision identity and divergence detection (ADR 0007, Issue #6 M2.1 gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpModel, loadModel } from "@vcv/ir";
import {
  FileStore,
  FileStoreReader,
  MemoryStore,
  ModelEngine,
  StoreError,
  branchSafeRevisionId,
  canonicalJson,
  inspectStore,
  isChildRevision,
  parseRevisionId,
  revisionDigest,
} from "../src/index.ts";
import { assertRev, baseModel, mcpAgent, owner, renamePending, reviewer, timeoutChange } from "./helpers.ts";

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
  // A read-only reader refuses it as well, as a fresh RepositoryProject.open() would.
  assert.ok(revA);
  assert.throws(() => new FileStoreReader(a), storeErr("DIVERGED"));
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

// Review on PR #8 (P1): two branch children merged with HEAD resolved to their common ancestor
// both verify as "next child of HEAD". They are real revisions and must never be orphaned.
function mergedAtAncestor({ keepChangeRecords }: { keepChangeRecords: boolean }) {
  const { root, a, b, revA, revB } = divergedPair();
  const merged = join(root, "merged");
  cpSync(join(root, "base"), merged, { recursive: true }); // HEAD = rev-1, the common ancestor
  for (const [side, rev] of [[a, revA], [b, revB]] as const) {
    cpSync(join(side, "revisions", `${rev}.yaml`), join(merged, "revisions", `${rev}.yaml`));
    if (keepChangeRecords) cpSync(join(side, "changes"), join(merged, "changes"), { recursive: true });
  }
  return { merged, revA, revB };
}

for (const keepChangeRecords of [true, false]) {
  test(`sibling branch revisions with HEAD at their common ancestor are DIVERGED, not leftovers (change records ${keepChangeRecords ? "kept" : "removed"})`, () => {
    const { merged, revA, revB } = mergedAtAncestor({ keepChangeRecords });
    const before = readdirSync(join(merged, "revisions")).sort();

    const inspected = inspectStore(merged);
    assert.equal(inspected.state, "diverged");
    if (inspected.state === "diverged") {
      assert.deepEqual(inspected.foreign.map((f) => f.id).sort(), [revA, revB].sort());
      assert.deepEqual(inspected.leftovers, []);
    }
    assert.throws(() => new FileStore(merged), storeErr("DIVERGED"));
    assert.deepEqual(readdirSync(join(merged, "revisions")).sort(), before, "no branch revision was moved");
    assert.ok(!existsSync(join(merged, "orphaned")) || readdirSync(join(merged, "orphaned")).length === 0);
  });
}

test("a single verified child is still foreign when an applied change record names it", () => {
  const { root, a, revA } = divergedPair();
  const merged = join(root, "merged-one");
  cpSync(join(root, "base"), merged, { recursive: true });
  cpSync(join(a, "revisions", `${revA}.yaml`), join(merged, "revisions", `${revA}.yaml`));
  cpSync(join(a, "changes"), join(merged, "changes"), { recursive: true });
  const inspected = inspectStore(merged);
  assert.equal(inspected.state, "diverged");
  assert.match(inspected.state === "diverged" ? inspected.foreign[0]!.reason : "", /records it as applied/);
  assert.throws(() => new FileStore(merged), storeErr("DIVERGED"));
  assert.ok(existsSync(join(merged, "revisions", `${revA}.yaml`)));
});

// Review on PR #8, round 2.
test("P2: a committed branch-safe revision edited in place is CORRUPT everywhere, and is not rewritten", () => {
  const dir = join(tmp(), "store");
  FileStore.init(dir, baseModel());
  const rev = new ModelEngine(new FileStore(dir)).propose(timeoutChange(), owner).record!.resultingRevision!;
  const file = join(dir, "revisions", `${rev}.yaml`);
  // A valid model, same modelRevision, different content: the ID would now mean two things.
  const edited = loadModel(readFileSync(file, "utf8")).model!;
  edited.project.name = "LMS (edited by hand)";
  writeFileSync(file, dumpModel(edited));
  const tampered = readFileSync(file, "utf8");

  const inspected = inspectStore(dir);
  assert.equal(inspected.state, "invalid");
  assert.match(inspected.state === "invalid" ? inspected.message : "", /does not match its ID/);
  assert.throws(() => new FileStore(dir), storeErr("CORRUPT"));
  assert.throws(() => new FileStoreReader(dir), storeErr("CORRUPT"));
  assert.equal(readFileSync(file, "utf8"), tampered, "corruption is reported, never repaired by rewriting");
});

test("P2: a revision file whose modelRevision disagrees with its name is CORRUPT; legacy content is not digest-checked", () => {
  const dir = join(tmp(), "store");
  FileStore.init(dir, baseModel());
  const legacy = baseModel();
  legacy.project.modelRevision = "rev-2";
  writeFileSync(join(dir, "revisions", "rev-2.yaml"), dumpModel(legacy));
  writeFileSync(join(dir, "HEAD"), JSON.stringify({ format: 1, revision: "rev-2", history: ["rev-1", "rev-2"] }) + "\n");
  assert.equal(inspectStore(dir).state, "ok", "legacy IDs carry no digest, so their content cannot be checked");
  legacy.project.modelRevision = "rev-7";
  writeFileSync(join(dir, "revisions", "rev-2.yaml"), dumpModel(legacy));
  assert.equal(inspectStore(dir).state, "invalid");
});

test("P1: an open writer follows HEAD on disk; a change based on the old line is rejected, not written over the new HEAD", () => {
  const { a, b, revB } = divergedPair();
  // Writer opened on a store at rev-1 ... then the checkout switches to b's line (rev-2-B).
  const root = join(a, "..", "checkout");
  cpSync(join(a, "..", "base"), root, { recursive: true });
  const store = new FileStore(root);
  const e = new ModelEngine(store);
  assert.equal(e.current().project.modelRevision, "rev-1");
  cpSync(join(b, "revisions"), join(root, "revisions"), { recursive: true });
  cpSync(join(b, "changes"), join(root, "changes"), { recursive: true });
  cpSync(join(b, "HEAD"), join(root, "HEAD"));
  const headAfterCheckout = readFileSync(join(root, "HEAD"), "utf8");

  const stale = e.propose(renamePending("ch-from-old-line", "rev-1"), owner);
  assert.equal(stale.status, "rejected");
  assert.equal(stale.diagnostics[0]!.code, "STALE_REVISION");
  assert.equal(readFileSync(join(root, "HEAD"), "utf8"), headAfterCheckout, "the checked-out line's HEAD is intact");

  const ok = e.propose({ ...renamePending("ch-on-new-line", revB), operations: [{ type: "renameObject", objectId: "mod-notifications", name: "Notify" }] }, owner);
  assert.equal(ok.status, "applied", JSON.stringify(ok.diagnostics));
  assert.deepEqual(store.revisions().slice(0, 2), ["rev-1", revB], "the new revision extends the checked-out line");
});

test("P1: commit refuses with HEAD_CHANGED if HEAD moves between validation and write, and writes nothing", () => {
  const { a, b } = divergedPair();
  const root = join(a, "..", "race");
  cpSync(join(a, "..", "base"), root, { recursive: true });
  const store = new FileStore(root);
  const model = store.current(); // validated against rev-1
  model.project.name = "LMS next";
  const id = branchSafeRevisionId(model, "rev-1", 2);
  model.project.modelRevision = id;
  cpSync(join(b, "revisions"), join(root, "revisions"), { recursive: true });
  cpSync(join(b, "HEAD"), join(root, "HEAD")); // the checkout happens right now
  const before = readdirSync(join(root, "revisions")).sort();
  const head = readFileSync(join(root, "HEAD"), "utf8");
  const record = { changeId: "ch-race", projectId: "prj-lms", proposerId: "user:hoang", status: "applied" as const, baseRevision: "rev-1", resultingRevision: id, validationResults: [], change: renamePending("ch-race") };
  assert.throws(() => store.commit(model, record), storeErr("HEAD_CHANGED"));
  assert.deepEqual(readdirSync(join(root, "revisions")).sort(), before);
  assert.equal(readFileSync(join(root, "HEAD"), "utf8"), head);
  assert.ok(!existsSync(join(root, "changes", "ch-race.json")));
});

// Review on PR #8, round 3.
test("P1: once an open writer has rejected a diverged checkout, every later read and write keeps rejecting it", () => {
  const { root, a, b, revA, revB } = divergedPair();
  const store = new FileStore(a);
  const e = new ModelEngine(store);
  assert.equal(e.current().project.modelRevision, revA);
  // The checkout changes to a diverged state: HEAD at the common ancestor, both branch children present.
  cpSync(join(root, "base", "HEAD"), join(a, "HEAD"));
  cpSync(join(b, "revisions", `${revB}.yaml`), join(a, "revisions", `${revB}.yaml`));
  cpSync(join(b, "changes"), join(a, "changes"), { recursive: true });
  const head = readFileSync(join(a, "HEAD"), "utf8");
  const revisions = readdirSync(join(a, "revisions")).sort();

  assert.throws(() => e.current(), storeErr("DIVERGED"), "first read");
  assert.throws(() => e.current(), storeErr("DIVERGED"), "second read must not serve the rejected HEAD");
  assert.throws(() => store.revisions(), storeErr("DIVERGED"));
  assert.throws(() => e.propose(renamePending("ch-after-reject", "rev-1"), owner), storeErr("DIVERGED"));
  assert.equal(readFileSync(join(a, "HEAD"), "utf8"), head, "HEAD untouched");
  assert.deepEqual(readdirSync(join(a, "revisions")).sort(), revisions, "no foreign revision moved");
  assert.ok(!existsSync(join(a, "orphaned")) || readdirSync(join(a, "orphaned")).length === 0);
  assert.ok(!existsSync(join(a, "changes", "ch-after-reject.json")));
});

test("P2: FileStoreReader notices a different model under the same revision ID", () => {
  const dir = join(tmp(), "store");
  FileStore.init(dir, baseModel());
  const reader = new FileStoreReader(dir);
  assert.equal(reader.current().project.name, "LMS");
  const other = baseModel();
  other.project.name = "Another LMS";
  writeFileSync(join(dir, "revisions", "rev-1.yaml"), dumpModel(other)); // what a checkout of another branch's rev-1 does
  assert.equal(reader.current().project.name, "Another LMS");
});

// Review on PR #8, round 4: divergence that leaves HEAD's bytes unchanged.
test("open writer and reader re-check integrity when revisions appear but HEAD is unchanged", () => {
  const { a, b, revA, revB } = divergedPair();
  const store = new FileStore(a);
  const e = new ModelEngine(store);
  const reader = new FileStoreReader(a);
  assert.equal(e.current().project.modelRevision, revA);
  assert.equal(reader.current().project.modelRevision, revA);
  // A merge resolved to this side's HEAD: B's revision and applied record arrive, HEAD stays.
  const head = readFileSync(join(a, "HEAD"), "utf8");
  cpSync(join(b, "revisions", `${revB}.yaml`), join(a, "revisions", `${revB}.yaml`));
  cpSync(join(b, "changes"), join(a, "changes"), { recursive: true });

  for (let i = 0; i < 2; i++) {
    assert.throws(() => e.current(), storeErr("DIVERGED"));
    assert.throws(() => reader.current(), storeErr("DIVERGED"));
  }
  assert.throws(() => e.propose(renamePending("ch-c", revA), owner), storeErr("DIVERGED"));
  assert.equal(readFileSync(join(a, "HEAD"), "utf8"), head);
  assert.ok(existsSync(join(a, "revisions", `${revB}.yaml`)));
  assert.ok(!existsSync(join(a, "changes", "ch-c.json")));
});

test("commit refuses with STORE_CHANGED if a same-ID revision file is swapped after validation", () => {
  const dir = join(tmp(), "store");
  FileStore.init(dir, baseModel());
  const store = new FileStore(dir);
  const model = store.current(); // validated: rev-1 is the fixture model
  model.project.name = "LMS next";
  const id = branchSafeRevisionId(model, "rev-1", 2);
  model.project.modelRevision = id;
  const other = baseModel();
  other.project.name = "Another branch's rev-1";
  writeFileSync(join(dir, "revisions", "rev-1.yaml"), dumpModel(other)); // HEAD line unchanged
  const head = readFileSync(join(dir, "HEAD"), "utf8");
  const record = { changeId: "ch-swap", projectId: "prj-lms", proposerId: "user:hoang", status: "applied" as const, baseRevision: "rev-1", resultingRevision: id, validationResults: [], change: renamePending("ch-swap") };
  assert.throws(() => store.commit(model, record), storeErr("STORE_CHANGED"));
  assert.equal(readFileSync(join(dir, "HEAD"), "utf8"), head);
  assert.ok(!existsSync(join(dir, "revisions", `${id}.yaml`)));
});

// Review on PR #8, round 5: the store moves between the engine's dry-run and the commit.
import type { ChangeGuard, ChangeRecord, HostContext, ModelStore, StoreSnapshot } from "../src/index.ts";

/**
 * A FileStore that runs a hook once, right after `on` (snapshot or getChange) returns its result
 * (a deterministic race: the decision was made, then the checkout lands).
 */
class RacingStore implements ModelStore {
  readonly inner: FileStore;
  private hook?: () => void;
  private readonly on: "snapshot" | "getChange";
  constructor(inner: FileStore, hook: () => void, on: "snapshot" | "getChange" = "snapshot") {
    this.inner = inner;
    this.hook = hook;
    this.on = on;
  }
  private after<T>(point: "snapshot" | "getChange", value: T): T {
    if (point !== this.on) return value;
    const h = this.hook;
    this.hook = undefined;
    h?.();
    return value;
  }
  snapshot(): StoreSnapshot { return this.after("snapshot", this.inner.snapshot()); }
  current() { return this.inner.current(); }
  revision(rev: string) { return this.inner.revision(rev); }
  revisions() { return this.inner.revisions(); }
  commit(m: Parameters<FileStore["commit"]>[0], r: ChangeRecord, g?: string | ChangeGuard) { this.inner.commit(m, r, g); }
  getChange(id: string) { return this.after("getChange", this.inner.getChange(id)); }
  putChange(r: ChangeRecord, g?: ChangeGuard) { this.inner.putChange(r, g); }
  appendAudit(e: Parameters<FileStore["appendAudit"]>[0]) { this.inner.appendAudit(e); }
  audit() { return this.inner.audit(); }
}

/** Replace `dir`'s store files with `other`'s, as a `git checkout` of another branch would. */
function checkoutLine(dir: string, other: string) {
  rmSync(join(dir, "revisions"), { recursive: true, force: true });
  rmSync(join(dir, "changes"), { recursive: true, force: true });
  cpSync(join(other, "revisions"), join(dir, "revisions"), { recursive: true });
  cpSync(join(other, "changes"), join(dir, "changes"), { recursive: true });
  cpSync(join(other, "HEAD"), join(dir, "HEAD"));
}

test("round 5: a checkout between dry-run and commit is refused; nothing is written", () => {
  const { root, b } = divergedPair();
  const dir = join(root, "racing");
  cpSync(join(root, "base"), dir, { recursive: true });
  const e = new ModelEngine(new RacingStore(new FileStore(dir), () => checkoutLine(dir, b)));
  const r = e.propose(timeoutChange(), owner); // validated against rev-1, then the checkout lands
  assert.equal(r.status, "rejected");
  assert.ok(["HEAD_CHANGED", "STORE_CHANGED"].includes(r.diagnostics[0]!.code), r.diagnostics[0]!.code);
  assert.equal(readFileSync(join(dir, "HEAD"), "utf8"), readFileSync(join(b, "HEAD"), "utf8"), "B's HEAD intact");
  assert.deepEqual(readdirSync(join(dir, "revisions")).sort(), readdirSync(join(b, "revisions")).sort(), "no revision written");
  assert.ok(!existsSync(join(dir, "changes", "ch-timeout-01.json")), "no record claims the change");
  // A retry re-reads, and is now (correctly) stale against B's line.
  assert.equal(e.propose(timeoutChange(), owner).diagnostics[0]!.code, "STALE_REVISION");
});

test("round 5: the store refuses a model validated on another line even after it adopted the new HEAD", () => {
  const { root, b, revB } = divergedPair();
  const dir = join(root, "adopted");
  cpSync(join(root, "base"), dir, { recursive: true });
  const store = new FileStore(dir);
  const snap = store.snapshot(); // at rev-1
  const model = structuredClone(snap.model);
  model.project.name = "LMS next";
  const id = branchSafeRevisionId(model, "rev-1", 2);
  model.project.modelRevision = id;
  const record = { changeId: "ch-late", projectId: "prj-lms", proposerId: "user:hoang", status: "applied" as const, baseRevision: "rev-1", resultingRevision: id, validationResults: [], change: renamePending("ch-late") };
  checkoutLine(dir, b);
  assert.deepEqual(store.revisions(), ["rev-1", revB], "the store auto-synced to B (the reviewer's path)");
  const head = readFileSync(join(dir, "HEAD"), "utf8");
  assert.throws(() => store.commit(model, record, snap.token), storeErr("HEAD_CHANGED"), "token from rev-1");
  assert.throws(() => store.commit(model, record), storeErr("HEAD_CHANGED"), "even without a token: baseRevision is not HEAD");
  assert.equal(readFileSync(join(dir, "HEAD"), "utf8"), head);
  assert.ok(!existsSync(join(dir, "revisions", `${id}.yaml`)));
});

test("round 5: a same-ID legacy base swapped after the snapshot is refused; a wrong-parent digest is refused", () => {
  const dir = join(tmp(), "store");
  FileStore.init(dir, baseModel());
  const store = new FileStore(dir);
  const snap = store.snapshot();
  const model = structuredClone(snap.model);
  model.project.name = "LMS next";
  const id = branchSafeRevisionId(model, "rev-1", 2);
  model.project.modelRevision = id;
  const record = { changeId: "ch-legacy", projectId: "prj-lms", proposerId: "user:hoang", status: "applied" as const, baseRevision: "rev-1", resultingRevision: id, validationResults: [], change: renamePending("ch-legacy") };
  const other = baseModel();
  other.project.name = "Another branch's rev-1";
  writeFileSync(join(dir, "revisions", "rev-1.yaml"), dumpModel(other));
  store.revisions(); // adopts the swapped (valid, same-line) state
  assert.throws(() => store.commit(model, record, snap.token), storeErr("STORE_CHANGED"));

  const fresh = store.snapshot();
  const wrong = structuredClone(model);
  wrong.project.modelRevision = branchSafeRevisionId(model, "rev-0", 2); // digest of another parent
  assert.throws(() => store.commit(wrong, { ...record, resultingRevision: wrong.project.modelRevision }, fresh.token), storeErr("BAD_COMMIT"));
  assert.deepEqual(store.revisions(), ["rev-1"]);
});

// Review on PR #8, round 6: non-committing record writes across a branch switch.
for (const kind of ["invalid (rejected)", "valid but needs approval (pending)"] as const) {
  test(`round 6: a ${kind} proposal never overwrites another branch's record with the same change ID`, () => {
    const root = tmp();
    const base = join(root, "base");
    FileStore.init(base, baseModel());
    const b = join(root, "b");
    cpSync(base, b, { recursive: true });
    // Branch B holds a legitimate pending proposal "ch-x".
    assert.equal(new ModelEngine(new FileStore(b)).propose(renamePending("ch-x"), mcpAgent).status, "pending");
    const bRecord = readFileSync(join(b, "changes", "ch-x.json"), "utf8");
    const bHead = readFileSync(join(b, "HEAD"), "utf8");

    const a = join(root, "a"); // branch A: no ch-x
    cpSync(base, a, { recursive: true });
    // The checkout lands right after the engine looked for an existing ch-x (and found none).
    const e = new ModelEngine(new RacingStore(new FileStore(a), () => checkoutLine(a, b), "getChange"));
    const change =
      kind === "invalid (rejected)"
        ? { ...renamePending("ch-x"), operations: [{ type: "removeObject" as const, objectId: "st-rejected" }] }
        : { ...renamePending("ch-x"), operations: [{ type: "renameObject" as const, objectId: "mod-notifications", name: "Notify" }] };
    const r = e.propose(change, kind === "invalid (rejected)" ? owner : mcpAgent);

    assert.equal(r.status, "rejected");
    assert.equal(r.diagnostics[0]!.code, "STORE_CHANGED");
    assert.equal(r.record, undefined, "nothing persisted");
    assert.equal(readFileSync(join(a, "changes", "ch-x.json"), "utf8"), bRecord, "B's pending proposal is byte-identical");
    assert.equal(readFileSync(join(a, "HEAD"), "utf8"), bHead);
    assert.equal(e.audit().at(-1)!.codes[0], "STORE_CHANGED", "the attempt is audited locally");
  });
}

test("round 6: a rejected approval does not overwrite a record that changed on disk", () => {
  const dir = join(tmp(), "store");
  FileStore.init(dir, baseModel());
  const e0 = new ModelEngine(new FileStore(dir));
  assert.equal(e0.propose(renamePending("ch-y"), mcpAgent).status, "pending");
  // Make it fail revalidation: the model moves on first.
  assert.equal(e0.propose({ ...renamePending("ch-z"), operations: [{ type: "renameObject", objectId: "mod-notifications", name: "Notify" }] }, owner).status, "applied");
  // Right after the approver's snapshot, the record is replaced (another checkout's ch-y).
  const replaced = readFileSync(join(dir, "changes", "ch-y.json"), "utf8").replace('"agent:mcp-session-1"', '"agent:other-branch"');
  const e = new ModelEngine(new RacingStore(new FileStore(dir), () => writeFileSync(join(dir, "changes", "ch-y.json"), replaced)));
  const r = e.approve("ch-y", reviewer);
  assert.equal(r.status, "rejected");
  assert.equal(r.diagnostics[0]!.code, "STORE_CHANGED");
  assert.equal(readFileSync(join(dir, "changes", "ch-y.json"), "utf8"), replaced);
});

// Review on PR #8, round 7: an applied commit pins the change record it was decided on.
function pendingOn(root: string, name: string, base: string, changeId: string): string {
  const dir = join(root, name);
  cpSync(base, dir, { recursive: true });
  assert.equal(new ModelEngine(new FileStore(dir)).propose(renamePending(changeId), mcpAgent).status, "pending");
  return dir;
}
const filesOf = (dir: string) => ({
  head: readFileSync(join(dir, "HEAD"), "utf8"),
  revisions: readdirSync(join(dir, "revisions")).sort(),
  changes: Object.fromEntries(readdirSync(join(dir, "changes")).sort().map((f) => [f, readFileSync(join(dir, "changes", f), "utf8")])),
});

test("round 7: an auto-applied proposal never overwrites another branch's pending record with the same ID", () => {
  const root = tmp();
  const base = join(root, "base");
  FileStore.init(base, baseModel());
  const b = pendingOn(root, "b", base, "ch-x"); // B: pending ch-x, HEAD still rev-1
  const before = filesOf(b);
  const a = join(root, "a"); // A: no ch-x
  cpSync(base, a, { recursive: true });
  const e = new ModelEngine(new RacingStore(new FileStore(a), () => checkoutLine(a, b), "getChange"));
  const r = e.propose(renamePending("ch-x"), owner); // owner: would auto-apply
  assert.equal(r.status, "rejected");
  assert.equal(r.diagnostics[0]!.code, "STORE_CHANGED");
  assert.equal(r.record, undefined);
  assert.deepEqual(filesOf(a), before, "B's HEAD, revisions and pending ch-x are byte-identical");
});

test("round 7: approving a pending record that vanished in a checkout is refused; nothing is written", () => {
  const root = tmp();
  const base = join(root, "base");
  FileStore.init(base, baseModel());
  const a = pendingOn(root, "a", base, "ch-y"); // A: pending ch-y
  const b = join(root, "b"); // B: no ch-y
  cpSync(base, b, { recursive: true });
  const before = filesOf(b);
  const e = new ModelEngine(new RacingStore(new FileStore(a), () => checkoutLine(a, b), "getChange"));
  const r = e.approve("ch-y", reviewer);
  assert.equal(r.status, "rejected");
  assert.equal(r.diagnostics[0]!.code, "STORE_CHANGED");
  assert.deepEqual(filesOf(a), before, "no phantom ch-y and no revision on B");
});

test("round 7: approving a pending record replaced by another branch's same-ID record is refused", () => {
  const root = tmp();
  const base = join(root, "base");
  FileStore.init(base, baseModel());
  const a = pendingOn(root, "a", base, "ch-y");
  const b = join(root, "b");
  cpSync(base, b, { recursive: true });
  const other: HostContext = { principalId: "agent:other-branch", permissions: ["model:propose"] };
  assert.equal(new ModelEngine(new FileStore(b)).propose({ ...renamePending("ch-y"), operations: [{ type: "renameObject", objectId: "mod-notifications", name: "Notify" }] }, other).status, "pending");
  const before = filesOf(b);
  const e = new ModelEngine(new RacingStore(new FileStore(a), () => checkoutLine(a, b), "getChange"));
  const r = e.approve("ch-y", reviewer);
  assert.equal(r.status, "rejected");
  assert.equal(r.diagnostics[0]!.code, "STORE_CHANGED");
  assert.deepEqual(filesOf(a), before, "B's own pending ch-y is not approved with A's content");
});

test("round 7: the store checks the record precondition of a commit even with a current token", () => {
  for (const make of [
    () => {
      const dir = join(tmp(), "store");
      FileStore.init(dir, baseModel());
      return new FileStore(dir) as ModelStore;
    },
    () => new MemoryStore(baseModel()) as ModelStore,
  ]) {
    const store = make();
    const e = new ModelEngine(store);
    assert.equal(e.propose(renamePending("ch-p"), mcpAgent).status, "pending");
    const pending = store.getChange("ch-p")!;
    const snap = store.snapshot();
    const model = structuredClone(snap.model);
    model.project.name = "LMS next";
    const id = branchSafeRevisionId(model, "rev-1", 2);
    model.project.modelRevision = id;
    const done = { ...pending, status: "applied" as const, resultingRevision: id };
    // A "new proposal" commit over an existing record, and an approval of a record that is not there.
    assert.throws(() => store.commit(model, done, { token: snap.token, previous: null }), storeErr("STORE_CHANGED"));
    assert.throws(() => store.commit(model, { ...done, changeId: "ch-none" }, { token: snap.token, previous: { ...pending, changeId: "ch-none" } }), storeErr("STORE_CHANGED"));
    assert.deepEqual(store.revisions(), ["rev-1"]);
    assert.equal(store.getChange("ch-p")!.status, "pending");
    store.commit(model, done, { token: snap.token, previous: pending }); // the exact record: accepted
    assert.deepEqual(store.revisions(), ["rev-1", id]);
  }
});

// Review on PR #8, round 8 (P2): status, reader and writer agree on an unreadable change record.
for (const [label, bytes] of [
  ["malformed JSON", '{"changeId": "ch-p", "status": "pend'],
  ["a record for another change", JSON.stringify({ changeId: "ch-other", status: "pending" })],
] as const) {
  test(`round 8: a change record holding ${label} makes inspection, the reader and the writer all refuse`, () => {
    const dir = join(tmp(), "store");
    FileStore.init(dir, baseModel());
    const e = new ModelEngine(new FileStore(dir));
    assert.equal(e.propose(timeoutChange(), owner).status, "applied");
    assert.equal(e.propose(renamePending("ch-p", e.current().project.modelRevision), mcpAgent).status, "pending");
    writeFileSync(join(dir, "changes", "ch-p.json"), bytes); // no conflict markers
    const before = filesOf(dir);

    const inspection = inspectStore(dir);
    assert.equal(inspection.state, "invalid");
    assert.match((inspection as { message: string }).message, /change record ch-p is unreadable/);
    assert.throws(() => new FileStoreReader(dir).current(), storeErr("CORRUPT"), "the reader does not serve it");
    assert.throws(() => new FileStore(dir), storeErr("CORRUPT"), "the writer refuses it");
    assert.deepEqual(filesOf(dir), before, "nothing was moved or rewritten");
    assert.ok(!existsSync(join(dir, "orphaned")) || readdirSync(join(dir, "orphaned")).length === 0);
  });
}
