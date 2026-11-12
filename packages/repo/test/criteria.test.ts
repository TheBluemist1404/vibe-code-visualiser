// Approved acceptance criteria and criterion ↔ test-case mappings (Issue #22, M4.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../core/src/index.ts";
import { loadModel } from "../../ir/src/index.ts";
import { CRITERIA_LIMITS, BindingError, reconcile, checkIntegrity, criteriaEvidence, previewProposal, projectStatus, readClaims, recordBinding, reviewApprove, submitProposal, addTrustedReviewer, createReviewerKey } from "../src/index.ts";
import type { CriteriaReport } from "../src/index.ts";
import { SPEC, agent, baseline, edit, git } from "./course-desk.ts";

const FULL = "EnrollmentService > rejects an enrollment into a full course and notifies the student";
const CONFIRM = "EnrollmentService > confirms an enrollment while seats are left and notifies the student";
const keys = mkdtempSync(join(tmpdir(), "vcv-crit-keys-")); // outside every checkout
let reviewer: ReturnType<typeof createReviewerKey> | undefined;
/** Trust user:hoang (one key for the whole file) and commit the trust list. */
function trust(repo: string) {
  reviewer ??= createReviewerKey("user:hoang", join(keys, "hoang.pem"));
  addTrustedReviewer(repo, reviewer);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "trust user:hoang");
}

const crit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "criterion",
  owner: "mod-enrollment",
  name: `Criterion ${id}`,
  statement: "A full course is rejected with COURSE_FULL and the student is notified.",
  verifies: ["rul-seat-limit"],
  verification: "required",
  ...over,
});

/** Submit and approve typed operations the M3 way: an agent proposes, a trusted reviewer approves. */
function approve(repo: string, changeId: string, operations: unknown[]) {
  const sub = submitProposal(repo, { changeId, projectId: "prj-course-desk", expectedRevision: projectStatus(repo).model!.revision, operations }, { principalId: "agent:coder", permissions: ["model:propose"] });
  assert.ok(sub.ok, JSON.stringify(sub));
  const pv = previewProposal(repo, { changeId });
  assert.ok(pv.ok, JSON.stringify(pv));
  const keyFile = join(keys, "hoang.pem");
  const head = git(repo, "rev-parse", "HEAD");
  const r = reviewApprove(repo, { changeId, expectedDigest: pv.data.proposal.proposalDigest, keyFile, trust: { kind: "git-ref", ref: head, pinnedCommit: head } });
  assert.equal(r.outcome.status, "applied", JSON.stringify(r));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `model: ${changeId}`);
}

/** Course Desk with a trusted reviewer and two approved criteria. */
function setup() {
  const repo = baseline();
  trust(repo);
  approve(repo, "chg-criteria", [
    { type: "createCriterion", criterion: crit("crt-full-course") },
    { type: "createCriterion", criterion: crit("crt-seat-notified", { statement: "Every decision notifies the student.", verifies: ["cap-enroll", "rul-seat-limit"], verification: "optional" }) },
  ]);
  return repo;
}

const map = (repo: string, criterionId: string, name: string, bindingId?: string) =>
  recordBinding(repo, { ...(bindingId ? { bindingId } : {}), modelObjectId: criterionId, relation: "tests", locator: { path: SPEC, selector: { kind: "test", name } }, rationale: "asserts the outcome" }, agent, null);

function ok(repo: string, input: unknown = {}, hooks = {}): CriteriaReport {
  const r = criteriaEvidence(repo, input, hooks);
  assert.ok(r.ok, JSON.stringify(r));
  return r.data;
}
const of = (d: CriteriaReport, id: string) => d.criteria.find((c) => c.id === id)!;
const problemCodes = (d: CriteriaReport, id: string) => of(d, id).problems.map((p) => p.code);

test("criteria are approved IR objects; a model without criteria keeps its exact canonical form", () => {
  const repo = baseline();
  const before = projectStatus(repo).model!.revision;
  const yaml = readFileSync(join(repo, ".vcv/revisions", `${before}.yaml`), "utf8");
  assert.ok(!yaml.includes("criteria"), "no criteria key is written for a model without criteria");
  const m = loadModel(yaml).model!;
  assert.equal(m.criteria, undefined);
  assert.ok(!canonicalJson(m).includes("criteria"));

  trust(repo);
  approve(repo, "chg-criteria", [{ type: "createCriterion", criterion: crit("crt-full-course") }]);
  const integrity = checkIntegrity(repo, {});
  assert.equal(integrity.ok, true, JSON.stringify(integrity.problems));

  const d = ok(repo);
  assert.equal(d.format, "vcv-criteria-1");
  assert.deepEqual(d.criteria.map((c) => [c.id, c.verification, c.verifies, c.moduleId, c.mapping]), [["crt-full-course", "required", ["rul-seat-limit"], "mod-enrollment", "none"]]);
  assert.deepEqual(problemCodes(d, "crt-full-course"), ["NO_MAPPING"]);
  assert.equal(d.counts.requiredUnmapped, 1);
  assert.equal(d.implementationChecked, false);
});

test("criterion operations are typed and validated: dangling refs and empty revisions are refused", () => {
  const repo = baseline();
  const rev = projectStatus(repo).model!.revision;
  const bad = submitProposal(repo, { changeId: "chg-bad", projectId: "prj-course-desk", expectedRevision: rev, operations: [{ type: "createCriterion", criterion: crit("crt-x", { verifies: ["cap-nope"] }) }] }, { principalId: "agent:coder", permissions: ["model:propose"] });
  assert.ok(bad.ok);
  assert.equal(bad.data.status, "rejected", "a criterion about a missing object is refused");
  assert.ok(bad.data.diagnostics.some((d) => d.code === "UNKNOWN_REF" && d.path === "criteria[0].verifies[0]"));
  const empty = submitProposal(repo, { changeId: "chg-empty", projectId: "prj-course-desk", expectedRevision: rev, operations: [{ type: "reviseCriterion", criterionId: "crt-x" }] }, { principalId: "agent:coder", permissions: ["model:propose"] });
  assert.ok(!empty.ok || empty.data.status === "rejected", "a revision with no field is refused");
  const policy = submitProposal(repo, { changeId: "chg-policy", projectId: "prj-course-desk", expectedRevision: rev, operations: [{ type: "createCriterion", criterion: crit("crt-x", { verification: "sometimes" }) }] }, { principalId: "agent:coder", permissions: ["model:propose"] });
  assert.ok(!policy.ok || policy.data.status === "rejected", "verification is required or optional");
});

test("mappings are tests claims on individual test cases, many-to-many, and reasserting one does not move HEAD", () => {
  const repo = setup();
  const head = readFileSync(join(repo, ".vcv/HEAD"), "utf8");
  map(repo, "crt-full-course", FULL, "test.crt-full-course");
  map(repo, "crt-seat-notified", FULL, "test.crt-seat-notified.full");
  map(repo, "crt-seat-notified", CONFIRM, "test.crt-seat-notified.confirm");
  assert.equal(readFileSync(join(repo, ".vcv/HEAD"), "utf8"), head, "mapping is evidence, not a model change");

  // Not a test case: refused, nothing written.
  assert.throws(() => recordBinding(repo, { modelObjectId: "crt-full-course", relation: "implements", locator: { path: SPEC, selector: { kind: "test", name: FULL } } }, agent, null), (e: unknown) => e instanceof BindingError && e.code === "INVALID_CLAIM");
  assert.throws(() => recordBinding(repo, { modelObjectId: "crt-full-course", relation: "tests", locator: { path: SPEC, selector: { kind: "file" } } }, agent, null), (e: unknown) => e instanceof BindingError && e.code === "INVALID_CLAIM");
  assert.throws(() => recordBinding(repo, { modelObjectId: "crt-full-course", relation: "tests", locator: { path: SPEC, selector: { kind: "test", name: "x".repeat(1001) } } }, agent, null), (e: unknown) => e instanceof BindingError && e.code === "INVALID_CLAIM");

  const d = ok(repo);
  assert.equal(of(d, "crt-full-course").mapping, "resolved");
  assert.deepEqual(of(d, "crt-full-course").problems, []);
  assert.deepEqual(of(d, "crt-full-course").mappings[0]!.alsoMapsTo, ["crt-seat-notified"]);
  assert.equal(of(d, "crt-seat-notified").mappings.length, 2);
  assert.deepEqual(d.tests.map((t) => [t.test.name, t.criteria]), [
    [CONFIRM, ["crt-seat-notified"]],
    [FULL, ["crt-full-course", "crt-seat-notified"]],
  ]);
  assert.equal(d.counts.requiredNotResolved, 0);
  assert.equal(d.counts.mappings, 3);

  // Reassert after the claim exists: routine maintenance, still no model revision.
  const entry = readClaims(repo).entries.find((e) => e.bindingId === "test.crt-full-course")!;
  recordBinding(repo, { bindingId: "test.crt-full-course", modelObjectId: "crt-full-course", relation: "tests", locator: { path: SPEC, selector: { kind: "test", name: FULL } }, rationale: "re-checked" }, agent, entry.digest);
  assert.equal(readFileSync(join(repo, ".vcv/HEAD"), "utf8"), head);
  assert.equal(ok(repo, { ids: ["crt-full-course"] }).criteria.length, 1);
});

test("a renamed test is missing, a duplicated title is ambiguous, an edited test is changed", () => {
  const repo = setup();
  map(repo, "crt-full-course", FULL, "test.crt-full-course");
  map(repo, "crt-seat-notified", CONFIRM, "test.crt-seat-notified");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "map");

  edit(repo, SPEC, 'it("rejects an enrollment into a full course and notifies the student"', 'it("refuses a full course"');
  let d = ok(repo);
  assert.equal(of(d, "crt-full-course").mapping, "unresolved");
  assert.ok(problemCodes(d, "crt-full-course").includes("TEST_MISSING"));
  assert.equal(d.counts.requiredNotResolved, 1);
  git(repo, "checkout", "-q", "--", SPEC);

  // Duplicate the confirm test's title.
  edit(repo, SPEC, 'it("rejects a repeat enrollment without taking a second seat"', 'it("confirms an enrollment while seats are left and notifies the student"');
  d = ok(repo);
  assert.ok(problemCodes(d, "crt-seat-notified").includes("TEST_AMBIGUOUS"));
  assert.equal(of(d, "crt-full-course").mapping, "resolved", "the other mapping is untouched");
  git(repo, "checkout", "-q", "--", SPEC);

  // Change the body of the mapped test (not only a comment).
  const spec = readFileSync(join(repo, SPEC), "utf8");
  const at = spec.indexOf('it("rejects an enrollment into a full course');
  const brace = spec.indexOf("{", at) + 1;
  writeFileSync(join(repo, SPEC), `${spec.slice(0, brace)}\n    const extra = 1;${spec.slice(brace)}`);
  d = ok(repo);
  assert.ok(problemCodes(d, "crt-full-course").includes("TEST_CHANGED"), JSON.stringify(of(d, "crt-full-course")));
  assert.equal(of(d, "crt-full-course").mapping, "unresolved");
});

test("a revised criterion makes its mappings stale until reasserted; duplicates and non-test claims are reported", () => {
  const repo = setup();
  map(repo, "crt-full-course", FULL, "test.crt-full-course");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "map");
  approve(repo, "chg-revise", [{ type: "reviseCriterion", criterionId: "crt-full-course", statement: "A full course is rejected with COURSE_FULL and the capacity." }]);

  let d = ok(repo);
  assert.ok(problemCodes(d, "crt-full-course").includes("CRITERION_CHANGED"), JSON.stringify(of(d, "crt-full-course")));
  assert.equal(of(d, "crt-full-course").mapping, "unresolved");
  const entry = readClaims(repo).entries.find((e) => e.bindingId === "test.crt-full-course")!;
  recordBinding(repo, { bindingId: "test.crt-full-course", modelObjectId: "crt-full-course", relation: "tests", locator: { path: SPEC, selector: { kind: "test", name: FULL } } }, agent, entry.digest);
  d = ok(repo);
  assert.equal(of(d, "crt-full-course").mapping, "resolved");

  // A second claim on the same test case, and a hand-written non-test claim.
  map(repo, "crt-full-course", FULL, "test.crt-full-course.again");
  const tmpl = JSON.parse(readFileSync(join(repo, ".vcv/bindings/test.crt-full-course.json"), "utf8"));
  writeFileSync(join(repo, ".vcv/bindings/impl.crt-full-course.json"), JSON.stringify({ ...tmpl, bindingId: "impl.crt-full-course", relation: "implements" }, null, 2));
  writeFileSync(join(repo, ".vcv/bindings/test.crt-full-course.broken.json"), "{ nope");
  d = ok(repo);
  const codes = problemCodes(d, "crt-full-course");
  for (const c of ["DUPLICATE_MAPPING", "NOT_A_TEST_MAPPING", "MAPPING_INVALID"]) assert.ok(codes.includes(c as never), `${c} in ${codes}`);
});

test("an unreadable claim store gives mapping unknown, never none", { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false }, () => {
  const repo = setup();
  chmodSync(join(repo, ".vcv/bindings"), 0o000);
  try {
    const d = ok(repo);
    assert.equal(d.mappingsAvailable, false);
    assert.ok(d.criteria.every((c) => c.mapping === "unknown"));
  } finally {
    chmodSync(join(repo, ".vcv/bindings"), 0o755);
  }
});

test("an unreadable claim store (a file in place of the directory) gives mapping unknown", () => {
  const repo = setup();
  rmSync(join(repo, ".vcv/bindings"), { recursive: true });
  writeFileSync(join(repo, ".vcv/bindings"), "not a directory");
  const r = criteriaEvidence(repo);
  if (!r.ok) return assert.ok(["PROJECT_NOT_READY", "STORE_INVALID"].includes(r.error.code), JSON.stringify(r.error)); // the store itself is refused
  assert.equal(r.data.mappingsAvailable, false);
  assert.ok(r.data.criteria.every((c) => c.mapping === "unknown"));
  assert.equal(r.data.counts.requiredUnmapped, 0, "unknown is not unmapped");
});

test("one observation: a mapped test or a claim edited mid-read is STATE_CHANGED", () => {
  const repo = setup();
  map(repo, "crt-full-course", FULL, "test.crt-full-course");
  let once = true;
  const flip = (fn: () => void) => ({ afterRead: () => (once ? ((once = false), fn()) : undefined) });
  const r1 = criteriaEvidence(repo, {}, flip(() => edit(repo, SPEC, 'it("rejects an enrollment into a full course', 'it("rejects an enrollment into a  full course')));
  assert.equal(!r1.ok && r1.error.code, "STATE_CHANGED");
  git(repo, "checkout", "-q", "--", SPEC);
  once = true;
  const r2 = criteriaEvidence(repo, {}, flip(() => map(repo, "crt-seat-notified", CONFIRM)));
  assert.equal(!r2.ok && r2.error.code, "STATE_CHANGED");
});

test("read-only, deterministic, bounded and redacted; bad requests are refused", () => {
  const repo = setup();
  map(repo, "crt-full-course", FULL, "test.crt-full-course");
  const status = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
  const a = criteriaEvidence(repo);
  assert.deepEqual(a, criteriaEvidence(repo));
  assert.equal(git(repo, "status", "--porcelain=v1", "--untracked-files=all"), status);
  assert.ok(!JSON.stringify(a).includes(repo));

  // A long hand-written test name is cut, with the digest of the full one.
  const tmpl = JSON.parse(readFileSync(join(repo, ".vcv/bindings/test.crt-full-course.json"), "utf8"));
  const long = `EnrollmentService > ${"y".repeat(5000)}`;
  mkdirSync(join(repo, ".vcv/bindings"), { recursive: true });
  writeFileSync(join(repo, ".vcv/bindings/test.crt-full-course.long.json"), JSON.stringify({ ...tmpl, bindingId: "test.crt-full-course.long", locator: { ...tmpl.locator, selector: { kind: "test", name: long } } }, null, 2));
  const d = ok(repo);
  const m = of(d, "crt-full-course").mappings.find((x) => x.bindingId === "test.crt-full-course.long")!;
  assert.ok(m.test!.name.length <= CRITERIA_LIMITS.testNameChars);
  assert.equal(m.test!.nameDigest?.length, 64);
  assert.ok(of(d, "crt-full-course").problems.every((p) => p.message.length <= CRITERIA_LIMITS.textChars));

  const unknown = criteriaEvidence(repo, { ids: ["crt-nope"] });
  assert.equal(!unknown.ok && unknown.error.code, "INVALID_REQUEST");
  const extra = criteriaEvidence(repo, { other: 1 });
  assert.equal(!extra.ok && extra.error.code, "INVALID_REQUEST");
});

test("reconcile: a criterion the candidate adds without a test mapping is reported as such", () => {
  const repo = baseline();
  trust(repo);
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "feature");
  approve(repo, "chg-criteria", [{ type: "createCriterion", criterion: crit("crt-full-course") }]);
  const r = reconcile(repo, { base });
  assert.ok(r.ok, JSON.stringify(r));
  const f = r.data.findings.find((x) => x.code === "OBJECT_UNBOUND" && x.objectIds?.includes("crt-full-course"))!;
  assert.ok(f, JSON.stringify(r.data.findings.map((x) => x.code)));
  assert.match(f.message, /no test case is mapped to it/);
  assert.ok(r.data.model.delta.changes.some((c) => c.change === "added" && c.kind === "criterion" && c.id === "crt-full-course"));

  map(repo, "crt-full-course", FULL);
  const again = reconcile(repo, { base });
  assert.ok(again.ok);
  assert.ok(!again.data.findings.some((x) => x.code === "OBJECT_UNBOUND" && x.objectIds?.includes("crt-full-course")), "a mapping is a claim on the criterion");
});
