// The pre-merge reconciliation report and policy gate (Issue #22, M4.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, ModelEngine } from "../../core/src/index.ts";
import type { HostContext } from "../../core/src/index.ts";
import {
  REQUIRED_EVIDENCE,
  captureTestRun,
  preMergeGate,
  testIdentity,
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
/** A report as the host hands it over: with the identity it read before the tests ran. */
const junit = (report: Uint8Array, repo: string) => {
  const id = testIdentity(repo);
  return [{ report, ...JUNIT, ...(id.ok ? { before: id.data.identityDigest } : {}) }];
};

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
  const g = gate(repo, { base, junit: junit(PASS, repo) });
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
  const g = gate(repo, { base, junit: junit(FAIL, repo) });
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

  const agentGate = gate(repo, { base, junit: junit(PASS, repo) }, agentHost);
  assert.equal(agentGate.decision, "block");
  assert.ok(blocking(agentGate).some((r) => r.code === "RESULT_CLAIMED"));
});

test("a model-first PR with an attested approval passes; a hand-edited revision blocks on integrity", () => {
  const { repo, trusted, base } = setup();
  // The criteria commit, measured against the commit before it.
  const g = gate(repo, { base: trusted, junit: junit(PASS, repo) });
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
  const unapproved = gate(repo, { base, junit: junit(FAIL, repo) });
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
  const bad = gate(repo, { base, junit: junit(PASS, repo) });
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
  const g = gate(repo, { base, junit: junit(FAIL, repo), policyAtBase: ".github/vcv-policy.json" });
  assert.equal(g.decision, "block");
  assert.ok(codes(g, "block").includes("TEST_FAILED"));
  assert.ok(codes(g, "warn").includes("POLICY_CHANGED"));
  assert.match(g.policy.source, /\.github\/vcv-policy\.json at the base/);
  assert.equal(g.policy.changedByCandidate, true);
  assert.equal(g.policy.effective.observations.contradiction, "block");

  // No policy can lower a required criterion: that is approved intent (M3), not configuration.
  for (const required of [{ failed: "warn" }, { unverified: "off" }, { claimed: "warn" }]) {
    const r = preMergeGate(repo, { base, junit: junit(FAIL, repo), policy: { format: "vcv-policy-1", required } }, host);
    assert.equal(!r.ok && r.error.code, "POLICY_INVALID", JSON.stringify(required));
  }
  const unknownKey = preMergeGate(repo, { base, policy: { format: "vcv-policy-1", integrity: "off" } }, host);
  assert.equal(!unknownKey.ok && unknownKey.error.code, "POLICY_INVALID");
  assert.equal(REQUIRED_EVIDENCE.failed, "block");
  // Optional criteria stay configurable.
  const optionalOff = gate(repo, { base, junit: junit(FAIL, repo), policy: { format: "vcv-policy-1", optional: { failed: "off" } } });
  assert.equal(optionalOff.decision, "block", "the required failure still blocks");
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
  const g = gate(repo, { base, junit: junit(PASS, repo), observations });
  assert.notEqual(g.decision, "block", JSON.stringify(blocking(g)));
  const by = (id: string) => g.observations.find((o) => o.id === id)!;
  assert.equal(by("obs-reason").references, "verified");
  assert.equal(by("obs-reason").basis, "claim");
  assert.deepEqual(by("obs-reason").tests, [{ path: SPEC, name: FULL, check: "ok", mapped: true, result: "passed" }]);
  assert.equal(by("obs-ghost").references, "invalid");
  assert.equal(by("obs-ghost").objects[0]!.exists, false);
  assert.equal(by("obs-ghost").locations[0]!.check, "missing");
  assert.equal(by("obs-vague").references, "unsupported");
  assert.equal(by("obs-lines").locations[0]!.check, "line-out-of-range");
  const warn = codes(g, "warn");
  for (const c of ["AGENT_CONTRADICTION", "AGENT_CONCERN", "OBSERVATION_REFERENCES_INVALID", "OBSERVATION_WITHOUT_LOCATION"]) assert.ok(warn.includes(c), c);
  assert.ok(g.reasons.filter((r) => r.observationId).every((r) => r.basis === "claim"));

  // A team may block on unresolved agent contradictions; the reason still says it is a claim.
  const strict = gate(repo, { base, junit: junit(PASS, repo), observations, policy: { format: "vcv-policy-1", observations: { contradiction: "block" } } });
  assert.equal(strict.decision, "block");
  assert.match(blocking(strict).find((r) => r.observationId === "obs-reason")!.message, /agent claim, not checked by VCV/);

  const dup = preMergeGate(repo, { base, observations: { format: "vcv-observations-1", observations: [observations.observations[0], observations.observations[0]] } }, host);
  assert.equal(!dup.ok && dup.error.code, "INVALID_REQUEST");
});

test("requireEvidence blocks a touched object without a host-observed required pass", () => {
  const { repo, base } = codeFirst();
  const policy = { format: "vcv-policy-1", requireEvidence: [{ object: "rul-seat-limit" }, { object: "cap-enroll", reason: "enrollment is billing-relevant" }] };
  const g = gate(repo, { base, junit: junit(PASS, repo), policy });
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
  const moved = preMergeGate(repo, { base, junit: junit(PASS, repo) }, host, { afterRead: () => (once ? ((once = false), edit(repo, SERVICE, "Enrollment rules; every decision", "Enrollment rules (moved); every decision")) : undefined) });
  assert.equal(!moved.ok && moved.error.code, "STATE_CHANGED");
});

test("the same candidate gives the same report, and the checkout path never appears", () => {
  const { repo, base } = codeFirst();
  const a = JSON.stringify(gate(repo, { base, junit: junit(FAIL, repo) }));
  const b = JSON.stringify(gate(repo, { base, junit: junit(FAIL, repo) }));
  assert.equal(a, b);
  assert.ok(!a.includes(repo));
  assert.ok(Buffer.byteLength(a) < 512 * 1024);
});

// ---- review round 1 of PR #26 ---------------------------------------------------------------

test("a report is host-observed only with the identity read before the run: an old report cannot be rebound to new source", () => {
  const { repo, base } = codeFirst();
  const before = testIdentity(repo);
  assert.ok(before.ok);
  // The tests ran (PASS) on identity A; then the implementation changes (identity B).
  edit(repo, SERVICE, "...(reason ? { reason } : {}),", "");
  const raced = preMergeGate(repo, { base, junit: [{ report: PASS, ...JUNIT, before: before.data.identityDigest }] }, host);
  assert.equal(!raced.ok && raced.error.code, "TEST_RUN_RACED");
  // Without the pre-run identity the gate does not make one up: the report is a claim, and blocks.
  const unbound = gate(repo, { base, junit: [{ report: PASS, ...JUNIT }] });
  assert.equal(unbound.decision, "block");
  assert.equal(unbound.runs[0]!.observedBy, "claimed");
  assert.ok(blocking(unbound).some((r) => r.code === "RESULT_CLAIMED" && r.criterionId === "crt-full-course"));
});

test("Git reads in the candidate run none of its configured commands (fsmonitor, hooks, filter drivers)", () => {
  const { repo, base } = codeFirst();
  const marks = mkdtempSync(join(tmpdir(), "vcv-gate-marks-"));
  const touch = (name: string) => `sh -c 'touch ${join(marks, name)}; cat'`;
  git(repo, "config", "core.fsmonitor", `sh -c 'touch ${join(marks, "fsmonitor")}'`);
  git(repo, "config", "filter.evil.clean", touch("filter"));
  git(repo, "config", "diff.external", `sh -c 'touch ${join(marks, "diff")}'`);
  mkdirSync(join(repo, ".git/evil-hooks"));
  for (const h of ["post-index-change", "post-checkout", "reference-transaction"]) {
    writeFileSync(join(repo, ".git/evil-hooks", h), `#!/bin/sh\ntouch ${join(marks, h)}\n`, { mode: 0o755 });
  }
  git(repo, "config", "core.hooksPath", ".git/evil-hooks");
  writeFileSync(join(repo, ".git/info/attributes"), "* filter=evil diff=evil\n");
  edit(repo, SERVICE, "Enrollment rules; every decision", "Enrollment rules: every decision"); // stat-dirty, so status would clean-filter it
  const g = gate(repo, { base, junit: junit(PASS, repo) });
  assert.ok(g.decision);
  assert.deepEqual(readdirSync(marks), [], "no candidate-configured command ran");
});

test("approvals are rechecked through the final answer: a post-reconciliation tamper is STATE_CHANGED", () => {
  const { repo, trusted } = setup();
  const dir = join(repo, ".vcv/approvals");
  const att = join(dir, readdirSync(dir).find((f) => f.endsWith(".json"))!);
  const valid = readFileSync(att, "utf8");
  writeFileSync(att, `${valid}\n`); // already dirty, whitespace only: still a valid attestation
  const clean = gate(repo, { base: trusted, junit: junit(PASS, repo) });
  assert.equal(clean.reconciliation?.integrity.ok, true);
  const before = testIdentity(repo);
  assert.ok(before.ok);
  for (let k = 1; k <= 12; k++) {
    let n = 0;
    const r = preMergeGate(repo, { base: trusted, junit: [{ report: PASS, ...JUNIT, before: before.data.identityDigest }] }, host, {
      afterRead: () => {
        if (++n === k) writeFileSync(att, `${valid.replace(/"signedAt": "[^"]+"/, '"signedAt": "2000-01-01T00:00:00.000Z"')}\n`);
      },
    });
    // Either the change is seen (STATE_CHANGED), or the tamper came after the last read and the
    // answer describes the bytes it read; never a pass computed on bytes that are no longer there.
    if (n >= k) assert.ok(!r.ok && r.error.code === "STATE_CHANGED", `tamper at read ${k}: ${JSON.stringify(r.ok ? r.data.decision : r.error)}`);
    writeFileSync(att, `${valid}\n`);
  }
});

test("adding lower-severity findings never hides a blocking one behind the report's list cut", () => {
  const { repo, base: b0 } = setup();
  // On the base: a claim whose file does not exist (already broken there, so unrelated to the PR).
  const template = JSON.parse(readFileSync(join(repo, ".vcv/bindings/impl.cap-enroll.json"), "utf8"));
  const claim = (id: string, path: string) => writeFileSync(join(repo, `.vcv/bindings/${id}.json`), `${JSON.stringify({ ...template, bindingId: id, locator: { path, selector: { kind: "symbol", name: "Gone.away" } } }, null, 2)}\n`);
  claim("old.broken", "server/src/old-gone.ts");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "an old broken claim");
  const base = git(repo, "rev-parse", "HEAD");
  assert.notEqual(base, b0);
  git(repo, "checkout", "-qb", "feature");
  const policy = { format: "vcv-policy-1", bindings: { related: "off", unrelated: "block" } };
  const one = gate(repo, { base, junit: junit(PASS, repo), policy });
  assert.equal(one.decision, "block");
  assert.ok(blocking(one).some((r) => r.bindingId === "old.broken"));
  // 501 new (related, policy off) broken claims push the old one out of the report's 500 findings.
  for (let i = 0; i < 501; i++) claim(`bulk.${String(i).padStart(3, "0")}`, `server/src/missing-${i}.ts`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "many new claims");
  const many = gate(repo, { base, junit: junit(PASS, repo), policy });
  assert.equal(many.decision, "block", "the old blocker is still there");
  assert.ok(blocking(many).some((r) => r.bindingId === "old.broken"));
});

test("removing a changed object's claims does not take it out of requireEvidence", () => {
  const { repo, base } = setup();
  git(repo, "checkout", "-qb", "feature");
  edit(repo, SERVICE, "...(reason ? { reason } : {}),", "");
  for (const id of ["impl.cap-enroll", "impl.rul-seat-limit", "expose.cap-enroll"]) rmSync(join(repo, `.vcv/bindings/${id}.json`));
  git(repo, "commit", "-qam", "drop the reason, and the claims that pointed at it");
  const g = gate(repo, { base, junit: junit(PASS, repo), policy: { format: "vcv-policy-1", requireEvidence: [{ object: "cap-enroll" }] } });
  assert.equal(g.decision, "block");
  assert.deepEqual(blocking(g).filter((r) => r.code === "EVIDENCE_REQUIRED").map((r) => r.objectIds), [["cap-enroll"]]);
});

test("a base policy that exists but cannot be read is an error, never the defaults", () => {
  const { repo } = setup();
  mkdirSync(join(repo, ".github"), { recursive: true });
  writeFileSync(join(repo, ".github/vcv-policy.json"), JSON.stringify({ format: "vcv-policy-1", observations: { contradiction: "block" } }) + " ".repeat(70 * 1024));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "an oversized policy");
  const base = git(repo, "rev-parse", "HEAD");
  const r = preMergeGate(repo, { base, policyAtBase: ".github/vcv-policy.json" }, host);
  assert.equal(!r.ok && r.error.code, "POLICY_INVALID");
  assert.match(!r.ok ? r.error.message : "", /more than the 65536 read/);
  // A directory where the policy should be is not "absent" either.
  rmSync(join(repo, ".github/vcv-policy.json"));
  mkdirSync(join(repo, ".github/vcv-policy.json"));
  writeFileSync(join(repo, ".github/vcv-policy.json/x"), "{}");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "a directory");
  const dirBase = git(repo, "rev-parse", "HEAD");
  const d = preMergeGate(repo, { base: dirBase, policyAtBase: ".github/vcv-policy.json" }, host);
  assert.equal(!d.ok && d.error.code, "POLICY_INVALID");
  // Real absence still means the defaults.
  const none = gate(repo, { base: dirBase, policyAtBase: ".github/none.json" });
  assert.match(none.policy.source, /default \(no \.github\/none\.json at the base\)/);
});

test("observation references: a cited test must exist without any run, unchecked lines are never verified, cited files are guarded", () => {
  const { repo, base } = codeFirst();
  const obs = (o: Record<string, unknown>) => ({ format: "vcv-observations-1", observations: [{ id: "obs-x", kind: "concern", statement: "s", resolution: "inspect", ...o }] });
  const ghost = gate(repo, { base, observations: obs({ tests: [{ path: "server/src/ghost.test.ts", name: "Ghost > nonexistent" }] }) });
  assert.equal(ghost.observations[0]!.references, "invalid");
  assert.equal(ghost.observations[0]!.tests[0]!.check, "missing");
  const renamed = gate(repo, { base, observations: obs({ tests: [{ path: SPEC, name: "EnrollmentService > no such case" }] }) });
  assert.equal(renamed.observations[0]!.references, "invalid");

  // Too large to check the lines: not-checked, never verified.
  writeFileSync(join(repo, "server/big.log"), "x\n".repeat(2_200_000));
  appendFileSync(join(repo, ".gitignore"), "\nserver/big.log\n");
  git(repo, "commit", "-qam", "ignore the log");
  const big = gate(repo, { base, observations: obs({ locations: [{ path: "server/big.log", startLine: 3 }] }) });
  assert.equal(big.observations[0]!.locations[0]!.check, "not-checked");
  assert.equal(big.observations[0]!.references, "not-checked");
  assert.ok(codes(big, "warn").includes("OBSERVATION_REFERENCES_NOT_CHECKED"));

  // A cited (ignored) file truncated during the read: STATE_CHANGED, not a stale "line 15 ok".
  writeFileSync(join(repo, "server/notes.txt"), "line\n".repeat(20));
  appendFileSync(join(repo, ".gitignore"), "server/notes.txt\n");
  git(repo, "commit", "-qam", "ignore notes");
  let last = 0;
  const count = preMergeGate(repo, { base, observations: obs({ locations: [{ path: "server/notes.txt", startLine: 15 }] }) }, host, { afterRead: () => void last++ });
  assert.ok(count.ok);
  let n = 0;
  const cutMid = preMergeGate(repo, { base, observations: obs({ locations: [{ path: "server/notes.txt", startLine: 15 }] }) }, host, { afterRead: () => void (++n === last && writeFileSync(join(repo, "server/notes.txt"), "line\n")) });
  assert.equal(!cutMid.ok && cutMid.error.code, "STATE_CHANGED");
});
