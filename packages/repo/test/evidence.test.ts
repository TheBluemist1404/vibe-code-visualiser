// Read-only source-evidence queries (Issue #15, M2.5) on real Git checkouts of Course Desk with
// the M2.3 agent draft and M2.4 binding claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadModel } from "@vcv/ir";
import { FileStoreReader } from "@vcv/core";
import { createQueryApi } from "@vcv/query";
import { VCV_DIR, createEvidenceApi, initProject, listBindings, recordBinding } from "../src/index.ts";
import type { EvidenceResult } from "../src/index.ts";
import { CONTROLLER, DRAFT, ROOT, SERVICE, SPEC, agent, baseline, edit, git, read } from "./course-desk.ts";


/** sha256 of every file under .vcv/ and server/, plus `git status`: the observable state. */
function fingerprintTree(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (name === "node_modules") continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(repo, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(join(repo, VCV_DIR));
  walk(join(repo, "server/src"));
  out["git status"] = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
  out["git HEAD"] = git(repo, "rev-parse", "HEAD");
  return out;
}

function ok<T>(r: EvidenceResult<T>): T {
  if (!r.ok) assert.fail(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data;
}
function err<T>(r: EvidenceResult<T>, code: string) {
  assert.equal(r.ok, false, `expected ${code}, got ok`);
  if (!r.ok) assert.equal(r.error.code, code, JSON.stringify(r.error));
  return r as Extract<EvidenceResult<T>, { ok: false }>;
}

test("a bound rule and capability are found by object ID with claim, provenance, locator and state; draft is not verification", () => {
  const repo = baseline();
  const api = createEvidenceApi(repo);
  const r = api.getObjectEvidence({ id: "rul-seat-limit" });
  assert.ok(r.ok);
  assert.equal(r.context.snapshotStatus, "draft");
  assert.equal(r.context.implementationChecked, false);
  assert.equal(r.context.meaning, "unverified");
  assert.equal(r.context.source, "repository-evidence");
  assert.deepEqual(r.data.object, { id: "rul-seat-limit", kind: "rule", name: "Course capacity", inCurrentModel: true });
  assert.deepEqual(r.data.bindings.map((b) => [b.bindingId, b.state]), [["impl.rul-seat-limit", "resolved"], ["test.rul-seat-limit", "resolved"]]);
  const impl = r.data.bindings[0]!;
  // Four separate concerns: interpretation, existence, freshness, approval.
  assert.deepEqual(impl.claim!.provenance, { source: "agent", principalId: "agent:bootstrap", rationale: "the capacity check is in enroll()", confidence: 0.8 });
  assert.equal(impl.claim!.locator.text, `${SERVICE}#symbol:EnrollmentService.enroll`);
  assert.equal(impl.claim!.modelRevision, "rev-1");
  assert.equal(impl.locator!.state, "resolved");
  assert.deepEqual(impl.locator!.matches.map((m) => m.label), ["EnrollmentService.enroll"]);
  assert.equal(impl.freshness!.source.state, "unchanged");
  assert.equal(impl.freshness!.model.state, "unchanged");
  assert.deepEqual(impl.approval.approved, false);
  assert.equal(impl.digest, listBindings(repo).find((e) => e.bindingId === "impl.rul-seat-limit")!.digest);

  // Filters by relation and selector kind.
  assert.deepEqual(ok(api.getObjectEvidence({ id: "rul-seat-limit", relations: ["tests"] })).bindings.map((b) => b.bindingId), ["test.rul-seat-limit"]);
  assert.deepEqual(ok(api.getObjectEvidence({ id: "cap-enroll", selectorKinds: ["route"] })).bindings.map((b) => b.bindingId), ["expose.cap-enroll"]);
  // An object with no claims is found and has none; an unknown one is an error.
  assert.equal(ok(api.getObjectEvidence({ id: "mod-web" })).bindings.length, 0);
  err(api.getObjectEvidence({ id: "cap-nope" }), "UNKNOWN_ID");

  const one = ok(api.getBindingEvidence({ bindingId: "impl.cap-enroll" }));
  assert.equal(one.claim!.modelObjectId, "cap-enroll");
  err(api.getBindingEvidence({ bindingId: "impl.nope" }), "UNKNOWN_BINDING");

  const ov = ok(api.getEvidenceOverview());
  assert.deepEqual(ov.counts, { resolved: 4, stale: 0, missing: 0, ambiguous: 0, unchecked: 0, indeterminate: 0, invalid: 0, total: 4, disputed: 0 });
});

test("reads and refresh are observational: .vcv/, claims, source, Git status and HEAD hash the same before and after", () => {
  const repo = baseline();
  edit(repo, SERVICE, "  enroll(request: EnrollmentRequest)", "  enroll(request: EnrollmentRequest /* dirty */)");
  const before = fingerprintTree(repo);
  const api = createEvidenceApi(repo);
  for (let i = 0; i < 2; i++) {
    ok(api.getEvidenceOverview());
    ok(api.getObjectEvidence({ id: "cap-enroll" }));
    ok(api.getBindingEvidence({ bindingId: "impl.cap-enroll" }));
    ok(api.refreshEvidence());
    err(api.getObjectEvidence({ id: "cap-enroll", expectedRevision: "rev-9" }), "REVISION_MISMATCH");
  }
  assert.deepEqual(fingerprintTree(repo), before);
});

test("freshness: bound-method edit is stale, same-file edit is not, rename is missing, unsupported is unchecked, incomplete is indeterminate", () => {
  const repo = baseline();
  // Unsupported selector, stored deliberately.
  recordBinding(repo, { bindingId: "doc.cap-enroll", modelObjectId: "cap-enroll", relation: "implements", locator: { path: "README.md", selector: { kind: "symbol", name: "Enroll" } }, allowUnchecked: true }, agent, null);
  // A claim fingerprinted by a scheme this VCV does not know: evidence is incomplete.
  const exposeFile = join(repo, VCV_DIR, "bindings", "expose.cap-enroll.json");
  writeFileSync(exposeFile, read(exposeFile).replace('"vcv-fp-1"', '"vcv-fp-0"'));
  const api = createEvidenceApi(repo);
  const state = (id: string) => ok(api.getBindingEvidence({ bindingId: id }));

  edit(repo, SERVICE, /^(import[^\n]*\n)/, "$1// an unrelated comment line\nconst UNRELATED = 1;\n");
  let impl = state("impl.cap-enroll");
  assert.equal(impl.state, "resolved");
  assert.equal(impl.freshness!.source.fileChanged, true);
  assert.match(impl.freshness!.source.cause, /not evidence about this claim/);

  edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length > course.capacity");
  impl = state("impl.cap-enroll");
  assert.equal(impl.state, "stale");
  assert.equal(impl.freshness!.source.state, "changed");
  assert.equal(impl.freshness!.git.workingTree, "modified");

  edit(repo, SPEC, "rejects an enrollment into a full course", "waitlists an enrollment into a full course");
  assert.equal(state("test.rul-seat-limit").state, "missing");
  assert.equal(state("doc.cap-enroll").state, "unchecked");
  const expose = state("expose.cap-enroll");
  assert.equal(expose.state, "indeterminate");
  assert.match(expose.freshness!.source.cause, /vcv-fp-0/);

  const counts = ok(api.getEvidenceOverview()).counts;
  assert.deepEqual(
    [counts.resolved, counts.stale, counts.missing, counts.unchecked, counts.indeterminate],
    [0, 2, 1, 1, 1],
  );
  assert.deepEqual(ok(api.getEvidenceOverview({ states: ["stale"] })).bindings.map((b) => b.bindingId), ["impl.cap-enroll", "impl.rul-seat-limit"]);
});

test("a branch checkout cannot fabricate freshness: mid-read changes are refused, and another line's claims are indeterminate", () => {
  const repo = baseline();
  git(repo, "checkout", "-q", "-b", "other");
  edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length > course.capacity");
  git(repo, "commit", "-q", "-am", "other: change enroll");
  git(repo, "checkout", "-q", "main");

  // A checkout lands between reading the claims and returning them.
  const flaky = createEvidenceApi(repo, { afterRead: () => git(repo, "checkout", "-q", "other") });
  const r = err(flaky.getEvidenceOverview(), "STATE_CHANGED");
  assert.ok(r.context, "context of the observation that was started");
  git(repo, "checkout", "-q", "main");

  // A model from another line of history: the claim's revision is unknown here, never "resolved".
  const branch = join(realpathSync(mkdtempSync(join(tmpdir(), "vcv-evidence-"))), "fresh");
  execFileSync("bash", [join(ROOT, "examples/reference-app/materialize.sh"), branch], { encoding: "utf8" });
  const model = loadModel(read(DRAFT)).model!;
  model.project.modelRevision = "rev-x";
  initProject(branch, model);
  execFileSync("cp", ["-r", join(repo, VCV_DIR, "bindings"), join(branch, VCV_DIR, "bindings")]);
  const ev = ok(createEvidenceApi(branch).getBindingEvidence({ bindingId: "impl.cap-enroll" }));
  assert.equal(ev.state, "indeterminate");
  assert.equal(ev.freshness!.model.state, "unknown");
});

test("a dirty source edit during a read is refused, never mixed: multi-claim, deleted file, and unbound edits", () => {
  const repo = baseline();
  const tree = () => git(repo, "status", "--porcelain=v1");
  // impl.cap-enroll and impl.rul-seat-limit bind the same method. Edit it between the two
  // verifications: without the guard one would read resolved and the other stale.
  let edited = false;
  const between = createEvidenceApi(repo, {
    afterVerify: (id) => {
      if (id === "impl.cap-enroll" && !edited) {
        edited = true;
        edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length > course.capacity");
      }
    },
  });
  const calls: (() => EvidenceResult<unknown>)[] = [() => between.getEvidenceOverview(), () => between.getObjectEvidence({ id: "cap-enroll" }), () => between.refreshEvidence()];
  for (const call of calls) {
    edited = false;
    git(repo, "checkout", "-q", "--", SERVICE);
    err(call(), "STATE_CHANGED");
  }

  // An uncommitted edit after all claims were verified, with HEAD, store and claims unchanged.
  git(repo, "checkout", "-q", "--", SERVICE);
  const after = createEvidenceApi(repo, { afterRead: () => edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length > course.capacity") });
  err(after.getBindingEvidence({ bindingId: "impl.rul-seat-limit" }), "STATE_CHANGED");
  // The next call observes the edited tree coherently: both claims on the method are stale.
  const now = ok(createEvidenceApi(repo).getEvidenceOverview());
  assert.deepEqual(now.bindings.filter((b) => b.locator?.startsWith(SERVICE)).map((b) => b.state), ["stale", "stale"]);

  // A bound file removed mid-read.
  git(repo, "checkout", "-q", "--", SERVICE);
  const gone = createEvidenceApi(repo, { afterRead: () => renameSync(join(repo, SPEC), join(repo, `${SPEC}.moved`)) });
  err(gone.getEvidenceOverview(), "STATE_CHANGED");
  renameSync(join(repo, `${SPEC}.moved`), join(repo, SPEC));

  // An edit to a file no claim binds is not part of the observation; nothing is refused.
  const unrelated = createEvidenceApi(repo, { afterRead: () => writeFileSync(join(repo, "README.md"), read(join(repo, "README.md")) + "\nmore\n") });
  assert.equal(ok(unrelated.getEvidenceOverview()).counts.resolved, 4);
  assert.match(tree(), /README\.md/);
});

test("deterministic output and pagination: cursors are bound to the request and the claim set", () => {
  const repo = baseline();
  const api = createEvidenceApi(repo);
  const all = ok(api.getEvidenceOverview()).bindings.map((b) => b.bindingId);
  assert.deepEqual(all, [...all].sort());
  assert.equal(JSON.stringify(api.getObjectEvidence({ id: "cap-enroll" })), JSON.stringify(createEvidenceApi(repo).getObjectEvidence({ id: "cap-enroll" })));

  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const p = ok(api.getEvidenceOverview({ limit: 1, ...(cursor ? { cursor } : {}) }));
    seen.push(...p.bindings.map((b) => b.bindingId));
    assert.equal(p.truncated, p.nextCursor !== undefined);
    cursor = p.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, all);

  const first = ok(api.getObjectEvidence({ id: "cap-enroll", limit: 1 }));
  assert.equal(first.matched, 2);
  const second = ok(api.getObjectEvidence({ id: "cap-enroll", limit: 1, cursor: first.nextCursor }));
  assert.deepEqual([...first.bindings, ...second.bindings].map((b) => b.bindingId), ["expose.cap-enroll", "impl.cap-enroll"]);
  err(api.getObjectEvidence({ id: "rul-seat-limit", limit: 1, cursor: first.nextCursor }), "INVALID_CURSOR");
  err(api.getEvidenceOverview({ cursor: "garbage" }), "INVALID_CURSOR");
  err(api.getEvidenceOverview({ cursor: first.nextCursor!.replace(/^rev-1/, "rev-2") }), "REVISION_MISMATCH");

  // A claim added after the first page invalidates the cursor instead of skipping it.
  const p1 = ok(api.getEvidenceOverview({ limit: 2 }));
  recordBinding(repo, { bindingId: "aaa.cap-enroll", modelObjectId: "cap-enroll", relation: "implements", locator: { path: SERVICE, selector: { kind: "file" } } }, agent, null);
  err(api.getEvidenceOverview({ limit: 2, cursor: p1.nextCursor }), "INVALID_CURSOR");
});

test("invalid requests, missing or unready projects, unsafe directories and unreadable claims give actionable results", () => {
  const repo = baseline();
  const api = createEvidenceApi(repo);
  const bad = err(api.getObjectEvidence({ id: "cap-enroll", limit: 0, color: "red" } as never), "INVALID_REQUEST");
  assert.ok(bad.error.details!.length >= 2);
  err(api.getObjectEvidence({} as never), "INVALID_REQUEST");
  err(api.getBindingEvidence({ bindingId: "../etc/passwd" }), "INVALID_REQUEST");
  err(api.getObjectEvidence({ id: "cap-enroll", relations: ["owns"] } as never), "INVALID_REQUEST");
  err(api.refreshEvidence({ since: "not-a-token" }), "INVALID_REQUEST");
  err(api.refreshEvidence({ bindingIds: ["impl.nope"] }), "UNKNOWN_BINDING");

  // Conflicted claim: listed as invalid, counted as unreadable for object queries; the model is still served.
  const file = join(repo, VCV_DIR, "bindings", "impl.cap-enroll.json");
  writeFileSync(file, `<<<<<<< ours\n${read(file)}=======\n{}\n>>>>>>> theirs\n`);
  const ov = ok(api.getEvidenceOverview());
  assert.equal(ov.counts.invalid, 1);
  assert.match(ov.bindings.find((b) => b.bindingId === "impl.cap-enroll")!.problem!, /conflict markers/);
  assert.equal(ok(api.getObjectEvidence({ id: "cap-enroll" })).unreadableClaims, 1);
  assert.equal(ok(api.getBindingEvidence({ bindingId: "impl.cap-enroll" })).state, "invalid");
  assert.ok(createQueryApi(new FileStoreReader(join(repo, VCV_DIR))).getContext({ id: "cap-enroll" }).ok);

  // A symlinked bindings directory is refused before anything is read.
  const dir = join(repo, VCV_DIR, "bindings");
  renameSync(dir, join(repo, "elsewhere"));
  symlinkSync(join(repo, "elsewhere"), dir);
  err(api.getEvidenceOverview(), "UNSAFE_PATH");
  err(api.getBindingEvidence({ bindingId: "impl.rul-seat-limit" }), "UNSAFE_PATH");

  // No project, and a conflicted model store.
  const none = realpathSync(mkdtempSync(join(tmpdir(), "vcv-evidence-")));
  const missing = err(createEvidenceApi(none).getEvidenceOverview(), "PROJECT_NOT_READY");
  assert.match(missing.error.message, /absent/);
  assert.ok(!JSON.stringify(missing).includes(none), "no absolute path in the error");
  writeFileSync(join(repo, VCV_DIR, "HEAD"), `<<<<<<< ours\n${read(join(repo, VCV_DIR, "HEAD"))}=======\n>>>>>>> theirs\n`);
  assert.match(err(api.getEvidenceOverview(), "PROJECT_NOT_READY").error.message, /conflicted/);
});

test("refresh rechecks the working tree on request, reports whether evidence changed since a token, and writes nothing", () => {
  const repo = baseline();
  const api = createEvidenceApi(repo);
  const r1 = ok(api.refreshEvidence());
  assert.equal(r1.writes, "none");
  assert.equal(r1.changedSince, null);
  assert.equal(ok(api.refreshEvidence({ since: r1.observationToken })).changedSince, false);
  edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length > course.capacity");
  const r2 = ok(api.refreshEvidence({ since: r1.observationToken }));
  assert.equal(r2.changedSince, true);
  assert.equal(r2.counts.stale, 2);
  const subset = ok(api.refreshEvidence({ bindingIds: ["test.rul-seat-limit"] }));
  assert.deepEqual(subset.bindings.map((b) => [b.bindingId, b.state]), [["test.rul-seat-limit", "resolved"]]);
});

test("results carry no absolute paths and no source text", () => {
  const repo = baseline();
  edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length > course.capacity");
  const api = createEvidenceApi(repo);
  const text = JSON.stringify([api.getEvidenceOverview(), api.getObjectEvidence({ id: "cap-enroll" }), api.getBindingEvidence({ bindingId: "test.rul-seat-limit" }), api.refreshEvidence()]);
  assert.ok(!text.includes(repo) && !text.includes(tmpdir()), "no absolute paths");
  assert.ok(!text.includes("course.capacity"), "no source text");
});
