// A Course Desk with evidence to look at (M5.5, Issue #45), built only from @vcv/repo's own
// functions and the repo package's test fixtures: claims, approved criteria mapped to test cases,
// an approved change with an implementation request and an agent's recorded report, and a test
// run the agent captured (a claim). Test-only keys; nothing here is a real user's key.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addTrustedReviewer,
  buildHandoff,
  captureTestRun,
  createReviewerKey,
  previewProposal,
  projectStatus,
  readBinding,
  recordBinding,
  recordImplementation,
  reviewApprove,
  submitProposal,
} from "@vcv/repo";
import { tempDir } from "@vcv/testkit";
import { ENROLL, SERVICE, edit, git } from "../../../packages/repo/test/course-desk.ts";
import { setup as criteria } from "../../../packages/repo/test/criteria-fixture.ts";

const JUNIT_DIR = join(import.meta.dirname, "../../../packages/repo/test/fixtures/junit");
export const PASS = readFileSync(join(JUNIT_DIR, "vitest-pass.xml"));
export const FAIL = readFileSync(join(JUNIT_DIR, "vitest-fail-skip.xml"));
const JUNIT = { root: "server", runner: { name: "vitest", version: "5.1.0" }, invocation: "npx vitest run" };
const agent = { principalId: "agent:coder", permissions: ["model:propose", "binding:record"] as const };

export const REQUEST = {
  behavior: "When a course is full, the rejection tells the student the course's capacity.",
  acceptanceCriteria: [
    "A COURSE_FULL rejection includes the course capacity",
    "Enrolling with free seats is unchanged",
  ],
  suggestedTests: ["EnrollmentService: rejects a full course and reports the capacity"],
  scope: ["server/src/enrollment/**"],
};

/** A run the agent captured itself and handed over: a claim, whatever it says. */
export function claimedRun(repo: string, report: Uint8Array = PASS): unknown {
  const r = captureTestRun(repo, report, JUNIT, { principalId: "agent:coder", permissions: [] });
  assert.ok(r.ok, JSON.stringify(r));
  return JSON.parse(JSON.stringify(r.data));
}

/**
 * main: claims, criteria crt-full-course (required) and crt-confirm (optional) mapped to tests,
 * a trusted test-only reviewer. feature: chg-capacity approved with an implementation request,
 * implemented (one in-scope edit, one out of scope) and reported. Returns the base commit.
 */
export function evidenceWorld() {
  const { repo } = criteria();
  const keyFile = join(tempDir("vcv-ui-keys-"), "reviewer.pem");
  addTrustedReviewer(repo, createReviewerKey("user:reviewer", keyFile));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "trust user:reviewer");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-qb", "feature");

  const changeId = "chg-capacity";
  const sub = submitProposal(
    repo,
    {
      changeId,
      projectId: "prj-course-desk",
      expectedRevision: projectStatus(repo).model!.revision,
      rationale: "students asked why they were rejected",
      operations: [
        {
          type: "setRuleStatement",
          ruleId: "rul-seat-limit",
          statement:
            "Confirmed enrollments never exceed capacity; a full course is rejected with COURSE_FULL and the capacity.",
        },
      ],
      implementation: REQUEST,
    },
    { principalId: "agent:coder", permissions: ["model:propose"] },
  );
  assert.ok(sub.ok, JSON.stringify(sub));
  const pv = previewProposal(repo, { changeId });
  assert.ok(pv.ok);
  const ok = reviewApprove(repo, {
    changeId,
    expectedDigest: pv.data.proposal.proposalDigest,
    keyFile,
    trust: { kind: "git-ref", ref: base, pinnedCommit: base },
  });
  assert.equal(ok.outcome.status, "applied", JSON.stringify(ok.outcome.diagnostics));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `vcv: approve ${changeId}`);
  const approvedRevision = projectStatus(repo).model!.revision;

  const h = buildHandoff(repo, changeId);
  assert.ok(h.ok, JSON.stringify(h));
  edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length >= course.capacity /* capacity reported */");
  const claim = readBinding(repo, "impl.rul-seat-limit")!;
  recordBinding(
    repo,
    {
      bindingId: "impl.rul-seat-limit",
      modelObjectId: "rul-seat-limit",
      relation: "implements",
      locator: ENROLL,
      rationale: "re-inspected after the change",
    },
    { ...agent, source: "agent" } as never,
    claim.digest,
  );
  const rec = recordImplementation(
    repo,
    {
      changeId,
      baseCommit: h.data.git.baseCommit!,
      handoffDigest: h.data.digest,
      testsRun: [{ command: "npm test -w server", outcome: "passed", summary: "12 passed" }],
      acceptance: [{ criterion: REQUEST.acceptanceCriteria[0]!, status: "met", evidence: "enrollment.service.ts" }],
      gaps: ["the web page does not show the capacity yet"],
      confidence: "medium",
    },
    agent,
  );
  assert.ok(rec.ok, JSON.stringify(rec));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "implement chg-capacity");
  return { repo, base, changeId, approvedRevision };
}
