// Course Desk with approved, attested acceptance criteria mapped to test cases (M4.4 tests).
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  addTrustedReviewer,
  createReviewerKey,
  previewProposal,
  projectStatus,
  recordBinding,
  reviewApprove,
  submitProposal,
} from "../src/index.ts";
import { SPEC, agent, baseline, git } from "./course-desk.ts";
import { tempDir } from "@vcv/testkit";

export const FULL = "EnrollmentService > rejects an enrollment into a full course and notifies the student";
export const CONFIRM = "EnrollmentService > confirms an enrollment while seats are left and notifies the student";

const keys = tempDir("vcv-gate-keys-");
let reviewer: ReturnType<typeof createReviewerKey> | undefined;
const crit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "criterion",
  owner: "mod-enrollment",
  name: id,
  statement: "A full course is rejected with COURSE_FULL and the student is notified.",
  verifies: ["rul-seat-limit"],
  verification: "required",
  ...over,
});

/** Course Desk on main: trusted reviewer, then (model-first) two approved criteria with mappings. Returns the two commits. */
export function setup() {
  const repo = baseline();
  reviewer ??= createReviewerKey("user:hoang", join(keys, "hoang.pem"));
  addTrustedReviewer(repo, reviewer);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "trust");
  const trusted = git(repo, "rev-parse", "HEAD");
  const changeId = "chg-criteria";
  const sub = submitProposal(
    repo,
    {
      changeId,
      projectId: "prj-course-desk",
      expectedRevision: projectStatus(repo).model!.revision,
      operations: [
        { type: "createCriterion", criterion: crit("crt-full-course") },
        {
          type: "createCriterion",
          criterion: crit("crt-confirm", {
            statement: "A free seat confirms the enrollment and notifies the student.",
            verification: "optional",
          }),
        },
      ],
    },
    { principalId: "agent:coder", permissions: ["model:propose"] },
  );
  assert.ok(sub.ok);
  const pv = previewProposal(repo, { changeId });
  assert.ok(pv.ok);
  assert.equal(
    reviewApprove(repo, {
      changeId,
      expectedDigest: pv.data.proposal.proposalDigest,
      keyFile: join(keys, "hoang.pem"),
      trust: { kind: "git-ref", ref: trusted, pinnedCommit: trusted },
    }).outcome.status,
    "applied",
  );
  recordBinding(
    repo,
    {
      bindingId: "test.full",
      modelObjectId: "crt-full-course",
      relation: "tests",
      locator: { path: SPEC, selector: { kind: "test", name: FULL } },
    },
    agent,
    null,
  );
  recordBinding(
    repo,
    {
      bindingId: "test.confirm",
      modelObjectId: "crt-confirm",
      relation: "tests",
      locator: { path: SPEC, selector: { kind: "test", name: CONFIRM } },
    },
    agent,
    null,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "criteria and mappings");
  return { repo, trusted, base: git(repo, "rev-parse", "HEAD") };
}
