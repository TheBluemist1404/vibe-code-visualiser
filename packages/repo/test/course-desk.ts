// Shared Course Desk fixture for evidence tests (Issue #15): the M2.3 draft, four M2.4 claims,
// committed as an explicit Git baseline.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModel } from "../../ir/src/index.ts";
import type { SourceLocator } from "../../core/src/index.ts";
import { initProject, recordBinding } from "../src/index.ts";
import type { BindingHost, RecordInput } from "../src/index.ts";

export const ROOT = join(import.meta.dirname, "../../..");
export const DRAFT = join(ROOT, "docs/samples/m2.3-bootstrap/agent-output/model.yaml");
export const SERVICE = "server/src/enrollment/enrollment.service.ts";
export const CONTROLLER = "server/src/enrollment/enrollment.controller.ts";
export const SPEC = "server/src/enrollment/enrollment.service.spec.ts";
export const ENROLL: SourceLocator = { path: SERVICE, selector: { kind: "symbol", name: "EnrollmentService.enroll" } };
export const agent: BindingHost = { principalId: "agent:bootstrap", permissions: ["binding:record"], source: "agent" };

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "VCV Test",
  GIT_AUTHOR_EMAIL: "vcv-test@example.invalid",
  GIT_COMMITTER_NAME: "VCV Test",
  GIT_COMMITTER_EMAIL: "vcv-test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
export const read = (p: string) => readFileSync(p, "utf8");
export const edit = (repo: string, rel: string, from: string | RegExp, to: string) => {
  const before = read(join(repo, rel));
  const after = before.replace(from, to);
  assert.notEqual(after, before, `edit of ${rel} changed nothing`);
  writeFileSync(join(repo, rel), after);
};

/** Course Desk with the draft, four claims, all committed as the baseline. */
export function baseline(): string {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "vcv-evidence-"))), "course-desk");
  execFileSync("bash", [join(ROOT, "examples/reference-app/materialize.sh"), repo], { encoding: "utf8" });
  initProject(repo, loadModel(read(DRAFT)).model!);
  const add = (over: Partial<RecordInput> & Pick<RecordInput, "modelObjectId" | "locator">) =>
    recordBinding(
      repo,
      { relation: "implements", rationale: "decides and records", confidence: 0.8, ...over },
      agent,
      null,
    );
  add({ bindingId: "impl.cap-enroll", modelObjectId: "cap-enroll", locator: ENROLL });
  add({
    bindingId: "impl.rul-seat-limit",
    modelObjectId: "rul-seat-limit",
    locator: ENROLL,
    rationale: "the capacity check is in enroll()",
  });
  add({
    bindingId: "expose.cap-enroll",
    modelObjectId: "cap-enroll",
    relation: "exposes",
    locator: { path: CONTROLLER, selector: { kind: "route", method: "POST", route: "/enrollments" } },
  });
  add({
    bindingId: "test.rul-seat-limit",
    modelObjectId: "rul-seat-limit",
    relation: "tests",
    locator: {
      path: SPEC,
      selector: {
        kind: "test",
        name: "EnrollmentService > rejects an enrollment into a full course and notifies the student",
      },
    },
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "vcv: draft model and claims");
  return repo;
}
