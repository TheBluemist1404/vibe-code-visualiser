// Per-test runner evidence and criterion-level results (Issue #22, M4.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../core/src/index.ts";
import type { HostContext } from "../../core/src/index.ts";
import {
  addTrustedReviewer,
  captureTestRun,
  createReviewerKey,
  criteriaEvidence,
  parseJUnit,
  previewProposal,
  projectStatus,
  recordBinding,
  reviewApprove,
  submitProposal,
  testIdentity,
} from "../src/index.ts";
import type { CriteriaReport, TestRunRecord } from "../src/index.ts";
import { SERVICE, SPEC, agent, baseline, edit, git } from "./course-desk.ts";

const FIX = join(import.meta.dirname, "fixtures/junit");
const PASS = readFileSync(join(FIX, "vitest-pass.xml"), "utf8");
const FAIL = readFileSync(join(FIX, "vitest-fail-skip.xml"), "utf8");
const FULL = "EnrollmentService > rejects an enrollment into a full course and notifies the student";
const CONFIRM = "EnrollmentService > confirms an enrollment while seats are left and notifies the student";
const REPEAT = "EnrollmentService > rejects a repeat enrollment without taking a second seat";
const host: HostContext = { principalId: "ci:main", permissions: ["tests:observe"] };
const agentHost: HostContext = { principalId: "agent:coder", permissions: [] };
const RUN = { root: "server", runner: { name: "vitest", version: "5.1.0" }, invocation: "npx vitest run --reporter=junit --outputFile=$RUNNER_TEMP/junit.xml" };
const xml = (s: string) => Buffer.from(s, "utf8");

const keys = mkdtempSync(join(tmpdir(), "vcv-runs-keys-"));
let reviewer: ReturnType<typeof createReviewerKey> | undefined;

const crit = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: "criterion", owner: "mod-enrollment", name: id, statement: "A full course is rejected with COURSE_FULL and the student is notified.", verifies: ["rul-seat-limit"], verification: "required", ...over });

/** Course Desk with two approved criteria, mapped to individual cases, committed. */
function setup() {
  const repo = baseline();
  reviewer ??= createReviewerKey("user:hoang", join(keys, "hoang.pem"));
  addTrustedReviewer(repo, reviewer);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "trust");
  const changeId = "chg-criteria";
  const sub = submitProposal(repo, { changeId, projectId: "prj-course-desk", expectedRevision: projectStatus(repo).model!.revision, operations: [
    { type: "createCriterion", criterion: crit("crt-full-course") },
    { type: "createCriterion", criterion: crit("crt-confirm", { statement: "A free seat confirms the enrollment and notifies the student.", verification: "optional" }) },
  ] }, { principalId: "agent:coder", permissions: ["model:propose"] });
  assert.ok(sub.ok);
  const pv = previewProposal(repo, { changeId });
  assert.ok(pv.ok);
  const head = git(repo, "rev-parse", "HEAD");
  assert.equal(reviewApprove(repo, { changeId, expectedDigest: pv.data.proposal.proposalDigest, keyFile: join(keys, "hoang.pem"), trust: { kind: "git-ref", ref: head, pinnedCommit: head } }).outcome.status, "applied");
  map(repo, "crt-full-course", FULL, "test.full");
  map(repo, "crt-confirm", CONFIRM, "test.confirm");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "criteria and mappings");
  return repo;
}
const map = (repo: string, id: string, name: string, bindingId: string) =>
  recordBinding(repo, { bindingId, modelObjectId: id, relation: "tests", locator: { path: SPEC, selector: { kind: "test", name } } }, agent, null);

function capture(repo: string, report: string, who: HostContext = host, extra: Record<string, unknown> = {}): TestRunRecord {
  const r = captureTestRun(repo, xml(report), { ...RUN, ...extra }, who);
  assert.ok(r.ok, JSON.stringify(r));
  return r.data;
}
function evaluate(repo: string, runs: TestRunRecord[], extra: Record<string, unknown> = {}): CriteriaReport {
  const r = criteriaEvidence(repo, { runs, ...extra });
  assert.ok(r.ok, JSON.stringify(r).slice(0, 1000));
  return r.data;
}
const of = (d: CriteriaReport, id: string) => d.criteria.find((c) => c.id === id)!;
const codes = (d: CriteriaReport, id: string) => of(d, id).problems.map((p) => p.code);

// ---- the report reader ------------------------------------------------------------------------

test("a real Vitest JUnit report: per-case identity, status and message", () => {
  const ok = parseJUnit(xml(PASS), "server");
  assert.ok(ok.ok);
  assert.equal(ok.report.cases.length, 8);
  assert.deepEqual(ok.report.summary, { tests: 8, passed: 8, failed: 0, errors: 0, skipped: 0 });
  const full = ok.report.cases.find((c) => c.name === FULL)!;
  assert.equal(full.path, SPEC, "classname is joined to the report root");
  assert.ok(ok.report.cases.some((c) => c.name === "NotificationsService > keeps each recipient's notifications separate, in order"), "entities are decoded");

  const bad = parseJUnit(xml(FAIL), "server");
  assert.ok(bad.ok);
  assert.deepEqual(bad.report.summary, { tests: 8, passed: 6, failed: 1, errors: 0, skipped: 1 });
  const f = bad.report.cases.find((c) => c.name === FULL)!;
  assert.equal(f.status, "failed");
  assert.match(f.message!, /to match object/);
  assert.equal(bad.report.cases.find((c) => c.name === REPEAT)!.status, "skipped");
});

test("the reader refuses DTDs, truncation, inconsistent counts, unsafe paths and malformed XML", () => {
  const refuse = (s: string | Uint8Array, code: string, re?: RegExp, root = "server") => {
    const r = parseJUnit(typeof s === "string" ? xml(s) : s, root);
    assert.ok(!r.ok, `refused: ${String(s).slice(0, 80)}`);
    assert.equal(r.code, code, r.message);
    if (re) assert.match(r.message, re);
  };
  refuse(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><testsuites/>`, "REPORT_INVALID", /DTD/);
  refuse(PASS.replace('name="vitest tests"', 'name="&a;"'), "REPORT_INVALID", /unknown entity/);
  refuse(PASS.slice(0, PASS.indexOf("</testsuite>")), "REPORT_INVALID", /truncated/);
  refuse(PASS.slice(0, PASS.length / 2), "REPORT_INVALID"); // cut mid-tag
  refuse(PASS.replace('tests="8"', 'tests="9"'), "REPORT_INCONSISTENT", /declares tests="9" but has 8/);
  // A failing case cut out of a red report (its suite still declares it).
  refuse(FAIL.replace(/<testcase[^>]*rejects an enrollment into a full course[\s\S]*?<\/testcase>/, ""), "REPORT_INCONSISTENT");
  // Flipping a failure to a pass without fixing the counts.
  refuse(FAIL.replace(/<failure[\s\S]*?<\/failure>/, ""), "REPORT_INCONSISTENT", /failures/);
  refuse(PASS.replace('classname="test/app.e2e-spec.ts"', 'classname="../../etc/passwd"'), "REPORT_INVALID", /path/);
  refuse(PASS, "UNSAFE_PATH", undefined, "../outside");
  refuse(new Uint8Array([0x3c, 0xff, 0xfe]), "REPORT_INVALID", /UTF-8/);
  refuse(`<html/>`, "REPORT_INVALID", /root element/);
  refuse(`<testsuites><testsuite></testsuites>`, "REPORT_INVALID");
  refuse(`<testsuites a="1" a="2"/>`, "REPORT_INVALID", /repeated/);
  refuse(`<testsuites>&</testsuites>`, "REPORT_INVALID", /bare/);
  const deep = `${"<testsuite>".repeat(40)}${"</testsuite>".repeat(40)}`;
  refuse(deep, "REPORT_INVALID", /deeper/);
});

// ---- capture and criterion results ------------------------------------------------------------

test("a host-observed passing run of this candidate: every mapped case passed", () => {
  const repo = setup();
  const run = capture(repo, PASS);
  assert.deepEqual([run.format, run.observedBy, run.principalId, run.summary.tests], ["vcv-test-run-1", "host", "ci:main", 8]);
  assert.equal(run.candidate.commit, git(repo, "rev-parse", "HEAD"));
  assert.equal(run.report.sha256, createHash("sha256").update(PASS).digest("hex"));
  const d = evaluate(repo, [run]);
  assert.deepEqual([of(d, "crt-full-course").result, of(d, "crt-full-course").resultObservedBy], ["passed", "host"]);
  assert.equal(of(d, "crt-full-course").mappings[0]!.result!.status, "passed");
  assert.equal(of(d, "crt-confirm").result, "passed");
  assert.deepEqual(d.results.required, { passed: 1, failed: 0, stale: 0, missing: 0, unknown: 0, unverified: 0 });
  assert.deepEqual([d.runs[0]!.fresh, d.runs[0]!.green], [true, true]);
  assert.deepEqual(d.notes, []);
  // Without runs nothing is verified.
  const none = criteriaEvidence(repo);
  assert.ok(none.ok);
  assert.ok(none.data.criteria.every((c) => c.result === "unverified"));
});

test("a failed mapped case fails its criterion, naming the exact case; a skipped one is missing", () => {
  const repo = setup();
  map(repo, "crt-confirm", REPEAT, "test.confirm.repeat"); // many-to-many: crt-confirm needs two cases
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "map repeat");
  const d = evaluate(repo, [capture(repo, FAIL)]);
  const full = of(d, "crt-full-course");
  assert.equal(full.result, "failed");
  const p = full.problems.find((x) => x.code === "TEST_FAILED")!;
  assert.match(p.message, /server\/src\/enrollment\/enrollment\.service\.spec\.ts > EnrollmentService > rejects an enrollment into a full course/);
  assert.match(p.message, /to match object/);
  assert.equal(p.bindingId, "test.full");
  const confirm = of(d, "crt-confirm");
  assert.equal(confirm.result, "missing", "one mapped case passed, the other was skipped");
  assert.ok(codes(d, "crt-confirm").includes("TEST_SKIPPED"));
  assert.equal(d.runs[0]!.green, false);
  assert.deepEqual(d.results.required.failed, 1);
  assert.deepEqual(d.results.optional.missing, 1);
});

test("a green suite does not stand in for a mapped case that did not run", () => {
  const repo = setup();
  // The same green report without the mapped case, counts adjusted: e.g. a filtered invocation.
  const filtered = PASS.replace(/<testcase[^>]*rejects an enrollment into a full course[\s\S]*?<\/testcase>/, "")
    .replace('tests="8"', 'tests="7"')
    .replace(/(name="src\/enrollment\/enrollment\.service\.spec\.ts" timestamp="[^"]*" hostname="[^"]*") tests="4"/, '$1 tests="3"');
  const d = evaluate(repo, [capture(repo, filtered)], { coverage: { linesPct: 97.5, source: "istanbul json-summary" } });
  assert.equal(d.runs[0]!.green, true);
  assert.equal(of(d, "crt-full-course").result, "missing");
  assert.ok(codes(d, "crt-full-course").includes("TEST_NOT_RUN"));
  const notes = d.notes.map((n) => n.code);
  assert.ok(notes.includes("SUITE_GREEN_REQUIRED_NOT_PASSED"), JSON.stringify(d.notes));
  assert.ok(notes.includes("COVERAGE_IS_NOT_CRITERION_COVERAGE"));
  assert.match(d.notes.find((n) => n.code === "COVERAGE_IS_NOT_CRITERION_COVERAGE")!.message, /97\.5%.*crt-full-course/);
  assert.equal(d.coverage!.linesPct, 97.5);
});

test("a run of another candidate is stale: a dirty edit, a new commit, a model change", () => {
  const repo = setup();
  const run = capture(repo, PASS);
  edit(repo, SERVICE, "Enrollment rules. Every decision", "Enrollment rules (edited). Every decision");
  let d = evaluate(repo, [run]);
  assert.equal(d.runs[0]!.fresh, false);
  assert.match(d.runs[0]!.staleBecause.join(), /uncommitted files differ/);
  assert.equal(of(d, "crt-full-course").result, "stale");
  assert.ok(codes(d, "crt-full-course").includes("RESULT_STALE"));
  assert.ok(d.notes.some((n) => n.code === "NO_FRESH_RUN"));

  git(repo, "commit", "-qam", "edit");
  d = evaluate(repo, [run]);
  assert.match(d.runs[0]!.staleBecause.join(), /it ran at commit/);
  assert.equal(of(d, "crt-full-course").result, "stale");

  // A fresh run next to the stale one: the fresh result counts, the stale one is only listed.
  const again = capture(repo, PASS);
  d = evaluate(repo, [run, again]);
  assert.deepEqual(d.runs.map((r) => r.fresh), [false, true]);
  assert.equal(of(d, "crt-full-course").result, "passed");
  assert.deepEqual(of(d, "crt-full-course").mappings[0]!.result!.runs, [1]);
});

test("agent-claimed runs are labelled and never host-observed", () => {
  const repo = setup();
  const run = capture(repo, PASS, agentHost);
  assert.equal(run.observedBy, "agent");
  const d = evaluate(repo, [run]);
  assert.deepEqual([of(d, "crt-full-course").result, of(d, "crt-full-course").resultObservedBy], ["passed", "agent"]);
  assert.ok(codes(d, "crt-full-course").includes("RESULT_AGENT_CLAIMED"));
});

test("an edited or forged record is refused: digest, summary, and shape", () => {
  const repo = setup();
  const red = capture(repo, FAIL);
  // Flip the failure to a pass and keep the old digest.
  const flipped = structuredClone(red);
  flipped.cases.find((c) => c.name === FULL)!.status = "passed";
  const r1 = criteriaEvidence(repo, { runs: [flipped] });
  assert.equal(!r1.ok && r1.error.code, "RUN_INVALID");
  assert.match(!r1.ok ? r1.error.message : "", /digest/);
  // Recompute the digest too: the summary no longer adds up.
  const { digest: _, ...body } = flipped;
  const resigned = { ...body, digest: createHash("sha256").update(canonicalJson(body)).digest("hex") };
  const r2 = criteriaEvidence(repo, { runs: [resigned] });
  assert.equal(!r2.ok && r2.error.code, "RUN_INVALID");
  assert.match(!r2.ok ? r2.error.message : "", /summary/);
  // An invented success JSON is not a record.
  const r3 = criteriaEvidence(repo, { runs: [{ format: "vcv-test-run-1", status: "passed" }] });
  assert.equal(!r3.ok && r3.error.code, "INVALID_REQUEST");
});

test("capture is refused if the candidate moved between reading its identity and capturing", () => {
  const repo = setup();
  const id = testIdentity(repo);
  assert.ok(id.ok);
  assert.equal(capture(repo, PASS, host, { before: id.data.identityDigest }).identityDigest, id.data.identityDigest);
  edit(repo, SERVICE, "Enrollment rules. Every decision", "Enrollment rules (raced). Every decision");
  const r = captureTestRun(repo, xml(PASS), { ...RUN, before: id.data.identityDigest }, host);
  assert.equal(!r.ok && r.error.code, "TEST_RUN_RACED");
  // Reports are refused before they are bound.
  const bad = captureTestRun(repo, xml(PASS.replace('tests="8"', 'tests="80"')), RUN, host);
  assert.equal(!bad.ok && bad.error.code, "REPORT_INCONSISTENT");
});

test("a duplicated case in a report makes its result ambiguous", () => {
  const repo = setup();
  const dup = PASS.replace(/(<testcase[^>]*rejects an enrollment into a full course[\s\S]*?<\/testcase>)/, "$1$1")
    .replace('tests="8"', 'tests="9"')
    .replace(/(name="src\/enrollment\/enrollment\.service\.spec\.ts" timestamp="[^"]*" hostname="[^"]*") tests="4"/, '$1 tests="5"');
  const d = evaluate(repo, [capture(repo, dup)]);
  assert.equal(of(d, "crt-full-course").mappings[0]!.result!.status, "ambiguous");
  assert.equal(of(d, "crt-full-course").result, "missing");
  assert.ok(codes(d, "crt-full-course").includes("RESULT_AMBIGUOUS"));
});

test("read-only and redacted: capture writes nothing and never prints the checkout path", () => {
  const repo = setup();
  const status = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
  const run = capture(repo, PASS);
  const d = criteriaEvidence(repo, { runs: [run] });
  assert.equal(git(repo, "status", "--porcelain=v1", "--untracked-files=all"), status);
  assert.ok(!JSON.stringify(run).includes(repo) && !JSON.stringify(d).includes(repo));
  writeFileSync(join(tmpdir(), "vcv-run-sample.json"), JSON.stringify(run)); // outside the checkout: identity unchanged
  assert.ok(evaluate(repo, [run]).runs[0]!.fresh);
});
