// The implementation handoff and the implementation evidence report (Issue #17, M3.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FileStore, ModelEngine } from "../../core/src/index.ts";
import type { HostContext, ProposedModelChange } from "../../core/src/index.ts";
import {
  addTrustedReviewer,
  buildHandoff,
  checkIntegrity,
  createReviewerKey,
  globMatcher,
  implementationStatus,
  previewProposal,
  projectStatus,
  readBinding,
  recordBinding,
  recordImplementation,
  reviewApprove,
  submitProposal,
} from "../src/index.ts";
import type { Handoff, ImplementationReportInput, TrustSource } from "../src/index.ts";
import { ENROLL, SERVICE, baseline, edit, git } from "./course-desk.ts";

const proposer: HostContext = { principalId: "agent:coder", permissions: ["model:propose"] };
const implementer: HostContext = { principalId: "agent:coder", permissions: ["model:propose", "binding:record"] };
const keys = mkdtempSync(join(tmpdir(), "vcv-keys-"));

const NEW_STATEMENT = "Confirmed enrollments for a course never exceed its capacity; a request for a full course is rejected with COURSE_FULL and the student is told how many seats the course has.";
const REQUEST = {
  behavior: "When a course is full, the rejection tells the student the course's capacity.",
  acceptanceCriteria: ["A COURSE_FULL rejection includes the course capacity", "Enrolling into a course with free seats is unchanged"],
  suggestedTests: ["EnrollmentService: rejects an enrollment into a full course and reports the capacity"],
  scope: ["server/src/enrollment/**"],
};

function setup() {
  const repo = baseline();
  const keyFile = join(keys, `hoang-${Math.random().toString(36).slice(2, 8)}.pem`);
  addTrustedReviewer(repo, createReviewerKey("user:hoang", keyFile));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "trust user:hoang");
  git(repo, "checkout", "-q", "-b", "feature");
  const pin = (): TrustSource => ({ kind: "git-ref", ref: "main", pinnedCommit: git(repo, "rev-parse", "main") });
  return { repo, keyFile, pin };
}

const rev = (repo: string) => projectStatus(repo).model!.revision;
const change = (repo: string, id: string, over: Partial<ProposedModelChange> = {}): ProposedModelChange => ({
  changeId: id,
  projectId: "prj-course-desk",
  expectedRevision: rev(repo),
  rationale: "students asked why they were rejected",
  operations: [{ type: "setRuleStatement", ruleId: "rul-seat-limit", statement: NEW_STATEMENT }],
  implementation: REQUEST,
  ...over,
});

/** Propose, preview, approve as the reviewer, commit the approval: the handoff's starting point. */
function approved(id = "chg-capacity", over: Partial<ProposedModelChange> = {}) {
  const s = setup();
  const c = change(s.repo, id, over);
  const sub = submitProposal(s.repo, c, proposer);
  assert.equal(sub.ok && sub.data.status, "pending", JSON.stringify(sub));
  const pv = previewProposal(s.repo, { changeId: id });
  assert.ok(pv.ok);
  const r = reviewApprove(s.repo, { changeId: id, expectedDigest: pv.data.proposal.proposalDigest, keyFile: s.keyFile, trust: s.pin() });
  assert.equal(r.outcome.status, "applied", JSON.stringify(r.outcome.diagnostics));
  git(s.repo, "add", "-A");
  git(s.repo, "commit", "-q", "-m", `approved ${id}`);
  return { ...s, id, preview: pv.data, approvedRevision: r.outcome.record!.resultingRevision! };
}

const storeModelHash = (repo: string) => {
  const h = createHash("sha256");
  for (const d of ["revisions", "changes", "approvals"]) for (const f of readdirSync(join(repo, ".vcv", d)).sort()) h.update(f).update(readFileSync(join(repo, ".vcv", d, f)));
  return h.update(readFileSync(join(repo, ".vcv/HEAD"))).digest("hex");
};

function report(h: Handoff, over: Partial<ImplementationReportInput> = {}): ImplementationReportInput {
  return {
    changeId: h.change.changeId,
    baseCommit: h.git.baseCommit!,
    handoffDigest: h.digest,
    testsRun: [{ command: "npm test -w server", outcome: "passed", summary: "12 passed" }],
    acceptance: REQUEST.acceptanceCriteria.map((criterion) => ({ criterion, status: "met" as const })),
    confidence: "medium",
    ...over,
  };
}

test("the implementation request is part of the proposal: previewed, covered by the digest, validated, and inert for the model", () => {
  const { repo } = setup();
  const c = change(repo, "chg-a");
  const pv = previewProposal(repo, { change: c });
  assert.ok(pv.ok);
  assert.deepEqual(pv.data.proposal.implementation, REQUEST);
  const without = previewProposal(repo, { change: { ...c, implementation: undefined } });
  assert.ok(without.ok);
  assert.notEqual(without.data.proposal.proposalDigest, pv.data.proposal.proposalDigest, "the digest covers the request");
  assert.ok(without.data.assumptions.some((a) => /no implementation request/.test(a)));
  for (const scope of [["/etc/passwd"], ["../outside/**"], ["C:/x"], ["server\\src"]]) {
    const r = submitProposal(repo, { ...c, changeId: "chg-bad", implementation: { ...REQUEST, scope } }, proposer);
    assert.equal(r.ok && r.data.status, "rejected", JSON.stringify(scope));
  }
  const extra = previewProposal(repo, { change: { ...c, implementation: { ...REQUEST, extra: 1 } } });
  assert.equal(!extra.ok && extra.error.code, "INVALID_REQUEST", "the request is strict: no smuggled fields");
});

test("handoff: only for an applied, attested change; deterministic, bounded and redacted; carries the approved request, delta, impact, bindings and base commit", () => {
  const { repo, id, preview, approvedRevision } = approved();
  const before = storeModelHash(repo);
  const r1 = buildHandoff(repo, id);
  assert.ok(r1.ok, JSON.stringify(r1));
  const h = r1.data;
  const r2 = buildHandoff(repo, id);
  assert.ok(r2.ok);
  assert.equal(JSON.stringify(r2.data), JSON.stringify(h), "same checkout, same bytes");
  assert.match(h.digest, /^[0-9a-f]{64}$/);
  assert.equal(storeModelHash(repo), before, "read-only");

  const text = JSON.stringify(h);
  assert.ok(!text.includes(repo), "no absolute checkout path");
  assert.ok(Buffer.byteLength(text) < 128 * 1024);
  assert.equal(h.change.proposalDigest, preview.proposal.proposalDigest);
  assert.equal(h.change.approvedRevision, approvedRevision);
  assert.equal(h.change.approverId, "user:hoang");
  assert.equal(h.approval.trustVerification, "caller-asserted");
  assert.deepEqual(h.request, REQUEST);
  assert.deepEqual(h.scope.declared, REQUEST.scope);
  assert.ok(h.scope.fromBindings.includes(SERVICE));
  assert.equal(h.git.baseCommit, git(repo, "rev-parse", "HEAD"));
  assert.equal(h.git.branch, "feature");
  assert.equal(h.modelNow.atApprovedRevision, true);
  assert.ok(h.delta.changes.some((c) => c.id === "rul-seat-limit" && c.change === "modified"));
  const seat = h.bindings.items.find((b) => b.bindingId === "impl.rul-seat-limit")!;
  assert.equal(seat.why, "changed");
  assert.equal(seat.state, "stale", "the model object changed since the claim");
  assert.equal(seat.reassertAfterImplementing, true);
  assert.ok(h.tests.bound.some((t) => t.bindingId === "test.rul-seat-limit"));
  assert.ok(h.steps.some((s) => /new proposal/.test(s)));
  assert.ok(h.caveats.some((c) => /not implemented source/.test(c)));
});

test("handoff refuses anything not approved and attested", () => {
  const { repo, keyFile, pin } = setup();
  // pending
  assert.ok(submitProposal(repo, change(repo, "chg-pending"), proposer).ok);
  const pending = buildHandoff(repo, "chg-pending");
  assert.equal(!pending.ok && pending.error.code, "NOT_APPLIED");
  assert.equal(((r) => !r.ok && r.error.code)(buildHandoff(repo, "chg-nope")), "UNKNOWN_CHANGE");
  // applied directly by a host, without a reviewer: no attestation
  const direct = new ModelEngine(new FileStore(join(repo, ".vcv"))).propose(change(repo, "chg-direct", { operations: [{ type: "setDescription", objectId: "mod-web", description: "direct" }] }), { principalId: "user:dev", permissions: ["model:propose", "model:apply"] });
  assert.equal(direct.status, "applied");
  const unattested = buildHandoff(repo, "chg-direct");
  assert.equal(!unattested.ok && unattested.error.code, "NOT_ATTESTED");
  // a tampered attestation
  const c = change(repo, "chg-b");
  submitProposal(repo, c, proposer);
  const pv = previewProposal(repo, { changeId: "chg-b" });
  assert.ok(pv.ok);
  assert.equal(reviewApprove(repo, { changeId: "chg-b", expectedDigest: pv.data.proposal.proposalDigest, keyFile, trust: pin() }).outcome.status, "applied");
  const att = join(repo, ".vcv/approvals/chg-b.json");
  writeFileSync(att, readFileSync(att, "utf8").replace(/"signedAt": "[^"]+"/, '"signedAt": "2000-01-01T00:00:00.000Z"'));
  const forged = buildHandoff(repo, "chg-b");
  assert.equal(!forged.ok && forged.error.code, "NOT_ATTESTED");
  // on main, the approved revision is not in the history
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "wip");
  git(repo, "checkout", "-q", "main");
  const other = buildHandoff(repo, "chg-b");
  assert.equal(!other.ok && other.error.code, "UNKNOWN_CHANGE", "the record itself is only on the feature branch");
});

test("implementation report: agent claims, VCV observations and warnings kept apart; scope, bindings, tests and criteria checked; the model never changes", () => {
  const { repo, id, approvedRevision } = approved();
  const h = (buildHandoff(repo, id) as { ok: true; data: Handoff }).data;
  const model = storeModelHash(repo);

  // The agent implements in scope, strays out of scope once, and reasserts one of two claims.
  edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length >= course.capacity /* capacity reported */");
  writeFileSync(join(repo, "README.md"), readFileSync(join(repo, "README.md"), "utf8") + "\nCapacity is reported on rejection.\n");
  const claim = readBinding(repo, "impl.rul-seat-limit")!;
  recordBinding(repo, { bindingId: "impl.rul-seat-limit", modelObjectId: "rul-seat-limit", relation: "implements", locator: ENROLL, rationale: "re-inspected: the capacity check and the new message" }, { ...implementer, source: "agent" } as never, claim.digest);

  const input = report(h, {
    testsRun: [{ command: "npm test -w server", outcome: "failed", summary: "1 failing: message text" }],
    acceptance: [{ criterion: REQUEST.acceptanceCriteria[0]!, status: "met", evidence: "enrollment.service.ts" }],
    outOfScope: [{ path: "README.md", reason: "documented the new message" }],
    gaps: ["web UI does not show the capacity yet"],
  });
  const r = recordImplementation(repo, input, implementer);
  assert.ok(r.ok, JSON.stringify(r));
  const rep = r.data.report;
  assert.equal(r.data.file, `.vcv/implementations/${id}.json`);
  assert.equal(rep.approvedRevision, approvedRevision);
  assert.equal(rep.handoffDigest, h.digest);
  assert.deepEqual(rep.approvedIntent.request, REQUEST);
  assert.equal(rep.agentClaims.claimedBy, "agent:coder");
  assert.equal(rep.agentClaims.verifiedByVcv, false);
  assert.equal(rep.notReconciled.state, "not-reconciled");
  assert.deepEqual(rep.vcvObserved.filesModified, ["README.md", SERVICE]);
  assert.deepEqual(rep.vcvObserved.outOfScope, ["README.md"]);
  assert.ok(rep.vcvObserved.store.bindings.length >= 1);
  const seat = rep.vcvObserved.bindings.find((b) => b.bindingId === "impl.rul-seat-limit")!;
  assert.equal(seat.reasserted, true);
  assert.equal(seat.claimedAtRevision, approvedRevision);
  const codes = rep.warnings.map((w) => w.code);
  for (const c of ["OUT_OF_SCOPE", "TEST_FAILED", "CRITERION_UNADDRESSED", "BINDING_NOT_REASSERTED", "GAP", "CLAIMS_UNVERIFIED"]) assert.ok(codes.includes(c), `${c} in ${codes}`);
  assert.match(rep.warnings.find((w) => w.code === "OUT_OF_SCOPE")!.message, /agent's explanation: documented/);
  assert.ok(rep.warnings.some((w) => w.code === "BINDING_NOT_REASSERTED" && w.bindingId === "test.rul-seat-limit"));
  assert.ok(!rep.warnings.some((w) => w.code === "BINDING_NOT_REASSERTED" && w.bindingId === "impl.rul-seat-limit"));
  assert.ok(!JSON.stringify(rep).includes(repo), "redacted");
  assert.equal(storeModelHash(repo), model, "recording a report changes no model state");
  assert.equal(rev(repo), approvedRevision);

  // Never overwritten silently; replaced only with the current digest.
  const again = recordImplementation(repo, input, implementer);
  assert.equal(!again.ok && again.error.code, "REPORT_EXISTS");
  const wrong = recordImplementation(repo, input, implementer, "0".repeat(64));
  assert.equal(!wrong.ok && wrong.error.code, "REPORT_CHANGED");
  const fixed = recordImplementation(repo, { ...input, testsRun: [{ command: "npm test -w server", outcome: "passed" }] }, implementer, r.data.digest);
  assert.ok(fixed.ok, JSON.stringify(fixed));
  assert.equal(fixed.data.replaced, true);
  assert.ok(!fixed.data.report.warnings.some((w) => w.code === "TEST_FAILED"));

  // show: recomputed now, and says when the checkout moved on since the report.
  const s1 = implementationStatus(repo, id);
  assert.ok(s1.ok, JSON.stringify(s1));
  assert.equal(s1.data.changedSinceReport, false);
  writeFileSync(join(repo, "package.json"), readFileSync(join(repo, "package.json"), "utf8") + "\n");
  const s2 = implementationStatus(repo, id);
  assert.ok(s2.ok);
  assert.equal(s2.data.changedSinceReport, true);
  assert.ok(s2.data.warningsNow.some((w) => w.code === "OUT_OF_SCOPE" && w.path === "package.json"));

  // The report rides along in the PR; the integrity gate is unaffected by it.
  git(repo, "checkout", "-q", "--", "package.json");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "implement chg-capacity");
  const gate = checkIntegrity(repo, { base: "main", trust: { kind: "git-ref", ref: "main" }, requireAttestation: true });
  assert.equal(gate.ok, true, JSON.stringify(gate.problems));
});

test("implementation report refusals: bad input, unknown or foreign base commit, unapproved change, unsafe directory; a model change during implementation is flagged", () => {
  const { repo, id, keyFile, pin } = approved();
  const h = (buildHandoff(repo, id) as { ok: true; data: Handoff }).data;
  const bad = recordImplementation(repo, { ...report(h), confidence: "certain" }, implementer);
  assert.equal(!bad.ok && bad.error.code, "INVALID_REQUEST");
  const unknown = recordImplementation(repo, report(h, { baseCommit: "1".repeat(40) }), implementer);
  assert.equal(!unknown.ok && unknown.error.code, "UNKNOWN_COMMIT");
  git(repo, "checkout", "-q", "-b", "side", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "side");
  const side = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "feature");
  const foreign = recordImplementation(repo, report(h, { baseCommit: side }), implementer);
  assert.equal(!foreign.ok && foreign.error.code, "UNKNOWN_COMMIT");
  assert.ok(submitProposal(repo, change(repo, "chg-pending", { operations: [{ type: "setDescription", objectId: "mod-web", description: "later" }] }), proposer).ok);
  const pending = recordImplementation(repo, report(h, { changeId: "chg-pending" }), implementer);
  assert.equal(!pending.ok && pending.error.code, "NOT_APPLIED");

  const elsewhere = mkdtempSync(join(tmpdir(), "vcv-elsewhere-"));
  symlinkSync(elsewhere, join(repo, ".vcv/implementations"));
  const unsafe = recordImplementation(repo, report(h), implementer);
  assert.equal(!unsafe.ok && unsafe.error.code, "UNSAFE_PATH");
  assert.equal(readdirSync(elsewhere).length, 0);
  rmSync(join(repo, ".vcv/implementations"));

  // A second approved change lands while implementing: the report for the first says the model moved.
  const pv = previewProposal(repo, { changeId: "chg-pending" });
  assert.ok(pv.ok);
  assert.equal(reviewApprove(repo, { changeId: "chg-pending", expectedDigest: pv.data.proposal.proposalDigest, keyFile, trust: pin() }).outcome.status, "applied");
  const moved = recordImplementation(repo, report(h), implementer);
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.ok(moved.data.report.warnings.some((w) => w.code === "MODEL_MOVED"));
  assert.ok(moved.data.report.warnings.some((w) => w.code === "NO_SOURCE_CHANGES"));
  assert.ok(statSync(join(repo, ".vcv/implementations", `${id}.json`)).isFile());
});

test("scope globs", () => {
  const m = (p: string) => globMatcher(p);
  assert.equal(m("server/src/enrollment/**")("server/src/enrollment/enrollment.service.ts"), true);
  assert.equal(m("server/src/enrollment/**")("server/src/enrollment/a/b.ts"), true);
  assert.equal(m("server/src/enrollment/**")("server/src/catalog/x.ts"), false);
  assert.equal(m("server/src/enrollment")("server/src/enrollment/x.ts"), true, "a plain path covers what is below it");
  assert.equal(m("server/src/enrollment")("server/src/enrollmentX.ts"), false);
  assert.equal(m("web/src/*.ts")("web/src/app.ts"), true);
  assert.equal(m("web/src/*.ts")("web/src/a/app.ts"), false);
  assert.equal(m("**/*.spec.ts")("server/src/x.spec.ts"), true);
  assert.equal(m("**/*.spec.ts")("x.spec.ts"), true);
  assert.equal(m("README.md")("README.md"), true);
});
