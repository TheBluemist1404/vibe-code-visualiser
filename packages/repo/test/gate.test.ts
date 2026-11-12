// The pre-merge reconciliation report and policy gate (Issue #22, M4.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileStore, ModelEngine } from "../../core/src/index.ts";
import type { HostContext } from "../../core/src/index.ts";
import {
  DEFAULT_POLICY,
  captureTestRun,
  preMergeGate,
  projectStatus,
} from "../src/index.ts";
import type { GateReport, GateRequest } from "../src/index.ts";
import { SERVICE, SPEC, edit, git } from "./course-desk.ts";
import { FULL, setup } from "./criteria-fixture.ts";

const FIX = join(import.meta.dirname, "fixtures/junit");
const PASS = readFileSync(join(FIX, "vitest-pass.xml"));
const FAIL = readFileSync(join(FIX, "vitest-fail-skip.xml"));
const host: HostContext = { principalId: "ci:gate", permissions: ["tests:observe"] };
const dev: HostContext = { principalId: "user:dev", permissions: ["model:propose", "model:apply"] };
const agentHost: HostContext = { principalId: "agent:coder", permissions: [] };
const JUNIT = { root: "server", runner: { name: "vitest", version: "5.1.0" }, invocation: "npx vitest run --reporter=junit" };
const junit = (report: Uint8Array) => [{ report, ...JUNIT }];

/** A code-first PR: a source edit on a branch, no model change. */
function codeFirst() {
  const s = setup();
  git(s.repo, "checkout", "-qb", "feature");
  edit(s.repo, SERVICE, "Enrollment rules. Every decision", "Enrollment rules; every decision");
  git(s.repo, "commit", "-qam", "reword a comment");
  return s;
}

function gate(repo: string, req: GateRequest, who: HostContext = host): GateReport {
  const r = preMergeGate(repo, req, who);
  assert.ok(r.ok, JSON.stringify(r).slice(0, 2000));
  return r.data;
}
const blocking = (g: GateReport) => g.reasons.filter((r) => r.severity === "block");
const codes = (g: GateReport, sev?: "block" | "warn") => g.reasons.filter((r) => !sev || r.severity === sev).map((r) => r.code);

test("a code-first PR whose required criterion passed in a run captured here is not blocked", () => {
  const { repo, base } = codeFirst();
  const g = gate(repo, { base, junit: junit(PASS) });
  assert.notEqual(g.decision, "block", JSON.stringify(blocking(g)));
  assert.equal(g.change.kind, "code-first");
  assert.equal(g.change.lineage, "unchanged");
  assert.deepEqual(g.criteria.items.map((c) => [c.id, c.result, c.observedBy]), [["crt-confirm", "passed", "host"], ["crt-full-course", "passed", "host"]]);
  assert.equal(g.runs[0]!.observedBy, "host");
  assert.equal(g.policy.source, "default");
  assert.match(g.headline, /1\/1 required criteria passed/);
  assert.equal(g.implementationChecked, false);
});

test("a failed mapped test case blocks, naming the criterion, the exact case and its message", () => {
  const { repo, base } = codeFirst();
  const g = gate(repo, { base, junit: junit(FAIL) });
  assert.equal(g.decision, "block");
  const r = blocking(g).find((x) => x.criterionId === "crt-full-course")!;
  assert.equal(r.code, "TEST_FAILED");
  assert.equal(r.rule, "required.failed");
  assert.deepEqual(r.test, { path: SPEC, name: FULL });
  assert.match(r.message, /to match object/);
  assert.deepEqual(r.objectIds, ["rul-seat-limit"]);
  // The optional criterion passed here; the green parts of the suite do not cancel the failure.
  assert.equal(g.criteria.items.find((c) => c.id === "crt-confirm")!.result, "passed");
  assert.match(g.headline, /blocked: .*crt-full-course/);
});

test("no runs, an imported record, or a capture without tests:observe never satisfies a required criterion", () => {
  const { repo, base } = codeFirst();
  const none = gate(repo, { base });
  assert.equal(none.decision, "block");
  assert.ok(codes(none, "block").includes("CRITERION_UNVERIFIED"));

  // A record the agent captured and handed over, then "upgraded" to host: still a claim.
  const rec = captureTestRun(repo, PASS, JUNIT, agentHost);
  assert.ok(rec.ok);
  const forged = JSON.parse(JSON.stringify({ ...rec.data, observedBy: "host" }));
  const imported = preMergeGate(repo, { base, runs: [forged] }, host);
  // The forged record no longer matches its digest: refused outright.
  assert.equal(!imported.ok && imported.error.code, "RUN_INVALID");
  const honest = gate(repo, { base, runs: [JSON.parse(JSON.stringify(rec.data))] });
  assert.equal(honest.decision, "block");
  assert.ok(blocking(honest).some((r) => r.code === "RESULT_CLAIMED" && r.criterionId === "crt-full-course"));

  const agentGate = gate(repo, { base, junit: junit(PASS) }, agentHost);
  assert.equal(agentGate.decision, "block");
  assert.ok(blocking(agentGate).some((r) => r.code === "RESULT_CLAIMED"));
});

test("a model-first PR with an attested approval passes; a hand-edited revision blocks on integrity", () => {
  const { repo, trusted, base } = setup();
  // The criteria commit, measured against the commit before it.
  const g = gate(repo, { base: trusted, junit: junit(PASS) });
  assert.notEqual(g.decision, "block", JSON.stringify(blocking(g)));
  assert.equal(g.change.kind, "model-first");
  assert.equal(g.change.introducedRevisions, 1);
  assert.equal(g.reconciliation?.integrity.ok, true);

  // Weaken the approved criterion with a direct engine write: a valid revision, but no approval.
  git(repo, "checkout", "-qb", "sneaky");
  const engine = new ModelEngine(new FileStore(join(repo, ".vcv")));
  const out = engine.propose({ changeId: "chg-sneaky", projectId: "prj-course-desk", expectedRevision: projectStatus(repo).model!.revision, operations: [{ type: "reviseCriterion", criterionId: "crt-full-course", verification: "optional" }] }, dev);
  assert.equal(out.status, "applied", JSON.stringify(out));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "make it optional");
  const unapproved = gate(repo, { base, junit: junit(FAIL) });
  assert.equal(unapproved.decision, "block");
  assert.ok(blocking(unapproved).some((r) => r.code === "APPROVAL_NOT_ATTESTED" && r.rule === "integrity"), JSON.stringify(unapproved.reasons));
  // The failure is now optional in the candidate's (unapproved) model, but integrity still blocks.
  assert.equal(unapproved.criteria.items.find((c) => c.id === "crt-full-course")!.verification, "optional");

  // A hand-edited revision file: the candidate's model is not even readable. Blocked, not an error.
  git(repo, "checkout", "-qb", "hand-edit", base);
  const dir = join(repo, ".vcv/revisions");
  const latest = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().at(-1)!;
  const file = join(dir, latest);
  writeFileSync(file, readFileSync(file, "utf8").replace("verification: required", "verification: optional"));
  git(repo, "commit", "-qam", "edit the revision");
  const bad = gate(repo, { base, junit: junit(PASS) });
  assert.equal(bad.decision, "block");
  assert.deepEqual(blocking(bad).map((r) => [r.code, r.rule]), [["PROJECT_NOT_READY", "integrity"]]);
  assert.match(bad.reasons[0]!.message, /does not match its ID/);
});

test("the policy comes from the host or the base commit; a candidate's own policy edit does not apply", () => {
  const { repo, base: b0 } = setup();
  // The base carries a strict policy: an observation of kind contradiction blocks.
  mkdirSync(join(repo, ".github"), { recursive: true });
  writeFileSync(join(repo, ".github/vcv-policy.json"), JSON.stringify({ format: "vcv-policy-1", observations: { contradiction: "block" } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "gate policy");
  const base = git(repo, "rev-parse", "HEAD");
  assert.notEqual(base, b0);
  git(repo, "checkout", "-qb", "feature");
  // The candidate relaxes required failures to warnings.
  writeFileSync(join(repo, ".github/vcv-policy.json"), JSON.stringify({ format: "vcv-policy-1", required: { failed: "warn" } }));
  git(repo, "commit", "-qam", "relax the gate");
  const g = gate(repo, { base, junit: junit(FAIL), policyAtBase: ".github/vcv-policy.json" });
  assert.equal(g.decision, "block");
  assert.ok(codes(g, "block").includes("TEST_FAILED"));
  assert.ok(codes(g, "warn").includes("POLICY_CHANGED"));
  assert.match(g.policy.source, /\.github\/vcv-policy\.json at the base/);
  assert.equal(g.policy.changedByCandidate, true);
  assert.equal(g.policy.effective.observations.contradiction, "block");

  // A host-supplied policy can lower a required result to warn, never to off.
  const lax = gate(repo, { base, junit: junit(FAIL), policy: { format: "vcv-policy-1", required: { failed: "warn" } } });
  assert.notEqual(lax.decision, "block");
  assert.ok(codes(lax, "warn").includes("TEST_FAILED"));
  const off = preMergeGate(repo, { base, policy: { format: "vcv-policy-1", required: { unverified: "off" } } }, host);
  assert.equal(!off.ok && off.error.code, "POLICY_INVALID");
  const unknownKey = preMergeGate(repo, { base, policy: { format: "vcv-policy-1", integrity: "off" } }, host);
  assert.equal(!unknownKey.ok && unknownKey.error.code, "POLICY_INVALID");
  assert.equal(DEFAULT_POLICY.required.unknown, "block");
});

test("agent observations are claims: references are checked, interpretations are not", () => {
  const { repo, base } = codeFirst();
  const observations = {
    format: "vcv-observations-1",
    observations: [
      { id: "obs-reason", kind: "contradiction", statement: "enroll() drops the rejection reason", objects: ["rul-seat-limit"], locations: [{ path: SERVICE, startLine: 1, endLine: 3 }], tests: [{ path: SPEC, name: FULL }], resolution: "fix-code", author: "agent:coder" },
      { id: "obs-ghost", kind: "concern", statement: "something about a module that does not exist", objects: ["mod-ghost"], locations: [{ path: "server/src/ghost.ts" }], resolution: "inspect" },
      { id: "obs-vague", kind: "contradiction", statement: "the code is wrong", resolution: "inspect" },
      { id: "obs-lines", kind: "note", statement: "context", locations: [{ path: SERVICE, startLine: 100000 }], resolution: "none" },
    ],
  };
  const g = gate(repo, { base, junit: junit(PASS), observations });
  assert.notEqual(g.decision, "block", JSON.stringify(blocking(g)));
  const by = (id: string) => g.observations.find((o) => o.id === id)!;
  assert.equal(by("obs-reason").references, "verified");
  assert.equal(by("obs-reason").basis, "claim");
  assert.deepEqual(by("obs-reason").tests, [{ path: SPEC, name: FULL, mapped: true, result: "passed" }]);
  assert.equal(by("obs-ghost").references, "invalid");
  assert.equal(by("obs-ghost").objects[0]!.exists, false);
  assert.equal(by("obs-ghost").locations[0]!.check, "missing");
  assert.equal(by("obs-vague").references, "unsupported");
  assert.equal(by("obs-lines").locations[0]!.check, "line-out-of-range");
  const warn = codes(g, "warn");
  for (const c of ["AGENT_CONTRADICTION", "AGENT_CONCERN", "OBSERVATION_REFERENCES_INVALID", "OBSERVATION_WITHOUT_LOCATION"]) assert.ok(warn.includes(c), c);
  assert.ok(g.reasons.filter((r) => r.observationId).every((r) => r.basis === "claim"));

  // A team may block on unresolved agent contradictions; the reason still says it is a claim.
  const strict = gate(repo, { base, junit: junit(PASS), observations, policy: { format: "vcv-policy-1", observations: { contradiction: "block" } } });
  assert.equal(strict.decision, "block");
  assert.match(blocking(strict).find((r) => r.observationId === "obs-reason")!.message, /agent claim, not checked by VCV/);

  const dup = preMergeGate(repo, { base, observations: { format: "vcv-observations-1", observations: [observations.observations[0], observations.observations[0]] } }, host);
  assert.equal(!dup.ok && dup.error.code, "INVALID_REQUEST");
});

test("requireEvidence blocks a touched object without a host-observed required pass", () => {
  const { repo, base } = codeFirst();
  const policy = { format: "vcv-policy-1", requireEvidence: [{ object: "rul-seat-limit" }, { object: "cap-enroll", reason: "enrollment is billing-relevant" }] };
  const g = gate(repo, { base, junit: junit(PASS), policy });
  const ev = blocking(g).filter((r) => r.code === "EVIDENCE_REQUIRED");
  // rul-seat-limit is verified by crt-full-course, which passed; no required criterion verifies cap-enroll.
  assert.deepEqual(ev.map((r) => r.objectIds), [["cap-enroll"]]);
  assert.match(ev[0]!.message, /none verifies it\. enrollment is billing-relevant/);
});

test("the gate refuses a base that is not a full commit ID, and a candidate that moves mid-read", () => {
  const { repo, base } = codeFirst();
  const short = preMergeGate(repo, { base: base.slice(0, 12) }, host);
  assert.equal(!short.ok && short.error.code, "INVALID_REQUEST");
  const ref = preMergeGate(repo, { base: "main" }, host);
  assert.equal(!ref.ok && ref.error.code, "INVALID_REQUEST");
  let once = true;
  const moved = preMergeGate(repo, { base, junit: junit(PASS) }, host, { afterRead: () => (once ? ((once = false), edit(repo, SERVICE, "Enrollment rules; every decision", "Enrollment rules (moved); every decision")) : undefined) });
  assert.equal(!moved.ok && moved.error.code, "STATE_CHANGED");
});

test("the same candidate gives the same report, and the checkout path never appears", () => {
  const { repo, base } = codeFirst();
  const a = JSON.stringify(gate(repo, { base, junit: junit(FAIL) }));
  const b = JSON.stringify(gate(repo, { base, junit: junit(FAIL) }));
  assert.equal(a, b);
  assert.ok(!a.includes(repo));
  assert.ok(Buffer.byteLength(a) < 512 * 1024);
});
