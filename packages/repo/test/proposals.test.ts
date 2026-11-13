// Agent-accessible proposals and the pre-approval preview (Issue #17, M3.1), on Course Desk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, ModelEngine } from "../../core/src/index.ts";
import type { HostContext, ProposedModelChange } from "../../core/src/index.ts";
import { STORE_FILE_LIMITS } from "../../core/src/index.ts";
import { PROPOSAL_LIMITS, listProposals, previewProposal, projectStatus, submitProposal } from "../src/index.ts";
import type { ProposalList, ProposalPreview, ProposalResult, SubmitResult } from "../src/index.ts";
import { baseline, git } from "./course-desk.ts";

const agent: HostContext = { principalId: "agent:coder", permissions: ["model:propose"] };
/** A host that holds everything: the proposal-only surface must still not apply. */
const everything: HostContext = {
  principalId: "agent:overprivileged",
  permissions: ["model:propose", "model:apply", "model:approve", "binding:record"],
};
const reviewer: HostContext = { principalId: "user:reviewer", permissions: ["model:approve"] };

const revision = (repo: string) => projectStatus(repo).model!.revision;
const data = <T>(r: ProposalResult<T>): T => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { data: T }).data;
};

/** The cross-module demo shape: a new Enrollment capability whose notification is a Notifications concern. */
const cancellation = (repo: string, over: Partial<ProposedModelChange> = {}): ProposedModelChange => ({
  changeId: "chg-cancel-enrollment",
  projectId: "prj-course-desk",
  expectedRevision: revision(repo),
  rationale: "A student can cancel a confirmed enrollment and is notified.",
  operations: [
    {
      type: "createCapability",
      capability: {
        id: "cap-cancel-enrollment",
        kind: "capability",
        owner: "mod-enrollment",
        name: "Cancel an enrollment",
        initiatorActorId: "act-student",
      },
    },
    {
      type: "setRuleStatement",
      ruleId: "rul-announce-every-decision",
      statement: "Each enrollment decision or cancellation results in exactly one notification to the student.",
    },
    {
      type: "setDescription",
      objectId: "dat-notification",
      description: "kind is enrollment-confirmed|enrollment-rejected|enrollment-cancelled.",
    },
    {
      type: "setDescription",
      objectId: "cap-enroll",
      description: "POST /enrollments; a confirmed enrollment can later be cancelled.",
    },
  ],
  ...over,
});

/** Hash of every file under .vcv/ except the local attempt log. */
function storeHash(repo: string): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f !== "audit.jsonl") h.update(p).update(readFileSync(p));
    }
  };
  walk(join(repo, ".vcv"));
  return h.digest("hex");
}
const headBytes = (repo: string) => readFileSync(join(repo, ".vcv/HEAD"), "utf8");
const revisionFiles = (repo: string) => readdirSync(join(repo, ".vcv/revisions")).sort();

test("submit is proposal-only: even a host holding model:apply and model:approve only records a pending change; .vcv/HEAD never moves", () => {
  const repo = baseline();
  const head = headBytes(repo);
  const revs = revisionFiles(repo);
  const change = cancellation(repo);
  const dry = data(previewProposal(repo, { change }));
  const r = data(submitProposal(repo, change, everything));
  assert.equal(r.ok, true);
  assert.equal(r.status, "pending");
  assert.equal(r.recorded, true);
  assert.deepEqual(r.modelRevision, { before: "rev-1", after: "rev-1" });
  assert.equal(r.proposalDigest, dry.proposal.proposalDigest, "the dry run and the record have the same identity");
  assert.equal(headBytes(repo), head);
  assert.deepEqual(revisionFiles(repo), revs);
  const record = JSON.parse(readFileSync(join(repo, ".vcv/changes/chg-cancel-enrollment.json"), "utf8"));
  assert.equal(record.status, "pending");
  assert.equal(record.proposerId, "agent:overprivileged");
  assert.equal(record.approverId, undefined);
  // approveDraft from the same over-privileged host is pending too, and the snapshot stays a draft.
  const draft = data(
    submitProposal(
      repo,
      {
        changeId: "chg-approve-draft",
        projectId: "prj-course-desk",
        expectedRevision: "rev-1",
        operations: [{ type: "approveDraft" }],
      },
      everything,
    ),
  );
  assert.equal(draft.status, "pending");
  assert.equal(projectStatus(repo).model!.status, "draft");
  assert.equal(headBytes(repo), head);
});

test("invalid, denied, replayed and oversized proposals fail with structured, hinted diagnostics and leave HEAD and revisions unchanged", () => {
  const repo = baseline();
  const head = headBytes(repo);
  const revs = revisionFiles(repo);
  const base = cancellation(repo);
  const submit = (c: unknown, host = agent) => data(submitProposal(repo, c, host));
  const codeOf = (r: SubmitResult) => r.diagnostics[0]!.code;

  const missing = submit({
    ...base,
    changeId: "chg-missing",
    operations: [{ type: "setDescription", objectId: "cap-nope", description: "x" }],
  });
  assert.equal(missing.status, "rejected");
  assert.equal(codeOf(missing), "TARGET_MISSING");
  assert.match(missing.diagnostics[0]!.hint!, /does not exist/);
  assert.equal(missing.recorded, true, "a well-formed, authorized proposal is recorded even when rejected");

  const dangling = submit({
    ...base,
    changeId: "chg-dangling",
    operations: [
      { type: "createCapability", capability: { id: "cap-x", kind: "capability", owner: "mod-nope", name: "X" } },
    ],
  });
  assert.equal(codeOf(dangling), "UNKNOWN_REF");
  const cycle = submit({
    ...base,
    changeId: "chg-cycle",
    operations: [{ type: "setModuleDependencies", moduleId: "mod-notifications", dependsOn: ["mod-enrollment"] }],
  });
  assert.equal(codeOf(cycle), "DEPENDENCY_CYCLE");
  const schema = submit({
    ...base,
    changeId: "chg-schema",
    operations: [{ type: "createCapability", capability: { id: "cap-y" } }],
  });
  assert.equal(codeOf(schema), "SCHEMA");
  assert.equal(schema.recorded, false);
  const smuggled = submit({ ...base, changeId: "chg-smuggle", status: "applied", approverId: "user:reviewer" });
  assert.equal(codeOf(smuggled), "SCHEMA", "proposer, approver and status cannot be supplied in the payload");
  const stale = submit({ ...base, changeId: "chg-stale", expectedRevision: "rev-0" });
  assert.equal(codeOf(stale), "STALE_REVISION");
  assert.match(stale.diagnostics[0]!.hint!, /re-read the current revision/);

  const denied = submit(
    { ...base, changeId: "chg-denied" },
    { principalId: "agent:reader", permissions: ["model:apply", "model:approve"] },
  );
  assert.equal(denied.status, "denied");
  assert.equal(denied.recorded, false);
  assert.equal(codeOf(denied), "NOT_AUTHORIZED");

  const big = submit({
    ...base,
    changeId: "chg-big",
    operations: Array.from({ length: PROPOSAL_LIMITS.maxOperations + 1 }, (_, i) => ({
      type: "setDescription",
      objectId: "cap-enroll",
      description: `d${i}`,
    })),
  });
  assert.equal(codeOf(big), "TOO_LARGE");
  assert.equal(big.recorded, false);

  assert.equal(submit(base).status, "pending");
  const recordBefore = readFileSync(join(repo, ".vcv/changes/chg-cancel-enrollment.json"), "utf8");
  const replay = submit({ ...base, rationale: "something else" }, everything);
  assert.equal(codeOf(replay), "DUPLICATE_CHANGE");
  assert.equal(replay.recorded, false);
  assert.equal(
    readFileSync(join(repo, ".vcv/changes/chg-cancel-enrollment.json"), "utf8"),
    recordBefore,
    "a replay never overwrites the original",
  );

  assert.equal(headBytes(repo), head);
  assert.deepEqual(revisionFiles(repo), revs);
  const ids = readdirSync(join(repo, ".vcv/changes")).sort();
  assert.deepEqual(ids, [
    "chg-cancel-enrollment.json",
    "chg-cycle.json",
    "chg-dangling.json",
    "chg-missing.json",
    "chg-stale.json",
  ]);
});

test("preview shows operations, the before/after delta, cross-module impact, affected claims, separate states and assumptions, and writes nothing", () => {
  const repo = baseline();
  data(submitProposal(repo, cancellation(repo), agent));
  const before = storeHash(repo);
  const p = data(previewProposal(repo, { changeId: "chg-cancel-enrollment" })) as ProposalPreview;
  assert.equal(storeHash(repo), before, "preview writes nothing");
  assert.equal(p.proposal.origin, "record");
  assert.equal(p.proposal.lifecycle, "pending");
  assert.equal(p.proposal.proposerId, "agent:coder");
  assert.equal(p.proposal.operations.length, 4);
  assert.match(p.proposal.operations[0]!.summary, /create capability cap-cancel-enrollment/);
  assert.equal(p.validation.appliesToCurrent, true);
  assert.deepEqual(p.validation.errors, []);

  assert.equal(p.delta!.against, "current");
  const byId = new Map(p.delta!.changes.map((c) => [c.id, c]));
  assert.equal(byId.get("cap-cancel-enrollment")!.change, "added");
  assert.equal(byId.get("cap-cancel-enrollment")!.moduleId, "mod-enrollment");
  const rule = byId.get("rul-announce-every-decision")!;
  assert.equal(rule.change, "modified");
  assert.deepEqual(
    rule.fields.map((f) => f.field),
    ["statement"],
  );
  assert.match(rule.fields[0]!.before!, /confirmed or rejected/);
  assert.match(rule.fields[0]!.after!, /cancellation/);
  assert.equal(byId.get("dat-notification")!.moduleId, "mod-notifications");

  assert.equal(p.impact!.crossModule, "yes");
  assert.deepEqual(
    p.impact!.modules.filter((m) => m.via === "changed").map((m) => m.id),
    ["mod-enrollment", "mod-notifications"],
  );
  assert.equal(p.impact!.impactClass, "structural-candidate");
  // Claims on cap-enroll (changed) are listed for revisiting, not verified.
  assert.deepEqual(p.bindings.items.map((b) => `${b.bindingId}:${b.why}`).sort(), [
    "expose.cap-enroll:changed",
    "impl.cap-enroll:changed",
  ]);

  assert.deepEqual(p.states, {
    snapshotStatus: "draft",
    change: "pending",
    approval: "none",
    implementation: "not-recorded",
  });
  assert.ok(p.assumptions.some((a) => /structural/.test(a)));
  assert.ok(p.assumptions.some((a) => /more than one module/.test(a)));
  assert.ok(
    p.assumptions.some((a) => /agent:coder/.test(a)),
    "the proposer identity is called a host assertion",
  );

  // Removing an object lists its claims as "removed" and traces impact in the model it is removed from.
  const removal = data(
    previewProposal(repo, {
      change: {
        changeId: "chg-remove",
        projectId: "prj-course-desk",
        expectedRevision: "rev-1",
        operations: [{ type: "removeObject", objectId: "rul-seat-limit" }],
      },
    }),
  );
  assert.equal(removal.proposal.origin, "unsubmitted");
  assert.equal(removal.delta!.changes[0]!.change, "removed");
  assert.deepEqual(removal.bindings.items.map((b) => `${b.bindingId}:${b.why}`).sort(), [
    "impl.rul-seat-limit:removed",
    "test.rul-seat-limit:removed",
  ]);
  assert.ok(removal.impact!.candidates.some((c) => c.id === "mod-enrollment"));
  assert.equal(storeHash(repo), before, "a dry run writes nothing either");
});

test("a preview that cannot apply reports why; a malformed dry run is INVALID_REQUEST with paths; unknown IDs are UNKNOWN_CHANGE", () => {
  const repo = baseline();
  const bad = data(
    previewProposal(repo, {
      change: {
        changeId: "chg-bad",
        projectId: "prj-course-desk",
        expectedRevision: "rev-1",
        operations: [{ type: "removeObject", objectId: "mod-notifications" }],
      },
    }),
  );
  assert.equal(bad.validation.appliesToCurrent, false);
  assert.equal(bad.delta, null);
  assert.equal(bad.impact, null);
  assert.ok(bad.validation.errors[0]!.hint);

  const malformed = previewProposal(repo, {
    change: {
      changeId: "chg-x",
      projectId: "prj-course-desk",
      expectedRevision: "rev-1",
      operations: [{ type: "patch", path: "/modules" }],
    },
  });
  assert.equal(malformed.ok, false);
  assert.equal((malformed as { error: { code: string } }).error.code, "INVALID_REQUEST");
  assert.ok(
    (malformed as { error: { details: { path: string }[] } }).error.details.some((d) =>
      d.path.startsWith("change.operations"),
    ),
  );
  const both = previewProposal(repo, { changeId: "chg-x", change: {} });
  assert.equal((both as { error: { code: string } }).error.code, "INVALID_REQUEST");
  const unknown = previewProposal(repo, { changeId: "chg-nope" });
  assert.equal((unknown as { error: { code: string } }).error.code, "UNKNOWN_CHANGE");
  // (Unparseable JSON makes the whole store invalid; a record whose change is not a typed change does not.)
  writeFileSync(
    join(repo, ".vcv/changes/chg-torn.json"),
    JSON.stringify({ changeId: "chg-torn", status: "pending", change: { patch: "/modules" } }),
  );
  assert.equal(
    (previewProposal(repo, { changeId: "chg-torn" }) as { error: { code: string } }).error.code,
    "INVALID_RECORD",
  );
  assert.equal(data(listProposals(repo)).counts.invalid, 1);
});

test("lifecycle: pending → applied by a separate reviewer; a second proposal on the old base becomes stale (superseded) and cannot be approved", () => {
  const repo = baseline();
  const a = cancellation(repo);
  const b = {
    ...cancellation(repo),
    changeId: "chg-other",
    operations: [{ type: "setDescription" as const, objectId: "mod-web", description: "Another view." }],
  };
  data(submitProposal(repo, a, agent));
  data(submitProposal(repo, b, agent));
  let list = data(listProposals(repo)) as ProposalList;
  assert.deepEqual(list.counts, { pending: 2, stale: 0, rejected: 0, applied: 0, invalid: 0 });

  // Approval is a separate step through ModelEngine (M3.2 adds the trusted reviewer invocation).
  const engine = new ModelEngine(new FileStore(join(repo, ".vcv")));
  assert.equal(engine.approve(a.changeId, agent).status, "denied", "the proposing agent cannot approve");
  const applied = engine.approve(a.changeId, reviewer);
  assert.equal(applied.status, "applied");
  const next = applied.record!.resultingRevision!;

  list = data(listProposals(repo));
  const byId = new Map(list.proposals.map((p) => [p.changeId, p]));
  assert.equal(byId.get(a.changeId)!.lifecycle, "applied");
  assert.equal(byId.get(a.changeId)!.resultingRevision, next);
  assert.equal(byId.get(a.changeId)!.resultInThisCheckout, true);
  assert.equal(byId.get(a.changeId)!.recordedApproverId, "user:reviewer");
  assert.equal(byId.get(a.changeId)!.approval, "approved-by-separate-reviewer");
  assert.equal(byId.get(a.changeId)!.implementation.state, "not-recorded");
  assert.equal(byId.get("chg-other")!.lifecycle, "stale");
  assert.equal(byId.get("chg-other")!.stale!.reason, "superseded");
  assert.deepEqual(
    data(listProposals(repo, { lifecycles: ["stale"] })).proposals.map((p) => p.changeId),
    ["chg-other"],
  );

  const stale = data(previewProposal(repo, { changeId: "chg-other" }));
  assert.equal(stale.validation.appliesToCurrent, false);
  assert.equal(stale.validation.errors[0]!.code, "STALE_REVISION");
  assert.equal(stale.delta!.against, "base", "a stale proposal still shows what it meant, against its base");
  assert.equal(stale.delta!.revision, "rev-1");
  assert.ok(stale.assumptions.some((x) => /stale/.test(x)));
  assert.equal(
    engine.approve("chg-other", reviewer).status,
    "rejected",
    "approval rechecks against the current revision",
  );

  const done = data(previewProposal(repo, { changeId: a.changeId }));
  assert.equal(done.states.approval, "approved-by-separate-reviewer");
  assert.equal(done.states.implementation, "not-recorded");
  assert.equal(done.states.snapshotStatus, "draft", "change approval is not snapshot approval");
});

test("a pending proposal from another branch is stale (other-line) here; the base checkout never sees the feature branch's revision", () => {
  const repo = baseline();
  git(repo, "checkout", "-q", "-b", "feature");
  const a = cancellation(repo);
  data(submitProposal(repo, a, agent));
  const applied = new ModelEngine(new FileStore(join(repo, ".vcv"))).approve(a.changeId, reviewer);
  assert.equal(applied.status, "applied");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "approved model change");
  const featureRev = revision(repo);
  // A follow-up proposal on the feature branch, left uncommitted (untracked) while switching back.
  data(
    submitProposal(
      repo,
      {
        ...cancellation(repo),
        changeId: "chg-followup",
        operations: [{ type: "setDescription", objectId: "mod-web", description: "x" }],
      },
      agent,
    ),
  );
  git(repo, "checkout", "-q", "main");
  assert.equal(revision(repo), "rev-1", "main still has the old model");
  const list = data(listProposals(repo));
  const follow = list.proposals.find((p) => p.changeId === "chg-followup")!;
  assert.equal(follow.lifecycle, "stale");
  assert.equal(follow.stale!.reason, "other-line");
  assert.equal(follow.baseRevision, featureRev);
  assert.equal(
    list.proposals.some((p) => p.changeId === a.changeId),
    false,
    "the applied record lives on the feature branch",
  );
  git(repo, "checkout", "-q", "feature");
  assert.equal(revision(repo), featureRev);
  assert.equal(data(listProposals(repo)).proposals.find((p) => p.changeId === "chg-followup")!.lifecycle, "pending");
});

test("an unready project is PROJECT_NOT_READY for submit, list and preview", () => {
  const repo = baseline();
  const change = cancellation(repo);
  writeFileSync(join(repo, ".vcv/HEAD"), "<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n");
  for (const r of [
    submitProposal(repo, change, agent),
    listProposals(repo),
    previewProposal(repo, { changeId: "chg-x" }),
  ]) {
    assert.equal(r.ok, false);
    assert.equal((r as { error: { code: string } }).error.code, "PROJECT_NOT_READY");
  }
});

test("a direct apply by a host holding model:apply is reported as applied-by-host, not as a separate reviewer's approval", () => {
  const repo = baseline();
  const out = new ModelEngine(new FileStore(join(repo, ".vcv"))).propose(cancellation(repo), {
    principalId: "user:owner",
    permissions: ["model:propose", "model:apply"],
  });
  assert.equal(out.status, "applied");
  const s = data(listProposals(repo)).proposals[0]!;
  assert.equal(s.lifecycle, "applied");
  assert.equal(s.approval, "applied-by-host");
  assert.equal(s.recordedApproverId, undefined);
  assert.equal(data(previewProposal(repo, { changeId: s.changeId })).states.approval, "applied-by-host");
});

test('crossModule is not-determined, not "no", when the impact list was cut before all candidates were seen', () => {
  const repo = baseline();
  const rename = {
    changeId: "chg-rename",
    projectId: "prj-course-desk",
    expectedRevision: "rev-1",
    operations: [{ type: "renameObject", objectId: "act-student", name: "Learner" }],
  };
  const cut = data(previewProposal(repo, { change: rename, limit: 1 }));
  assert.equal(cut.impact!.truncated, true);
  assert.equal(cut.impact!.crossModule, "not-determined");
  assert.ok(cut.assumptions.some((a) => /not determined/.test(a)));
  assert.notEqual(data(previewProposal(repo, { change: rename })).impact!.crossModule, "not-determined");
});

// ---- unsafe change-record entries (review of PR #18) ------------------------------------

/** A file outside the checkout that a malicious entry could point at. */
function outsideRecord(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vcv-outside-"));
  const p = join(dir, "record.json");
  writeFileSync(
    p,
    JSON.stringify({
      changeId: id,
      status: "pending",
      proposerId: "x",
      baseRevision: "rev-1",
      validationResults: [],
      change: {
        changeId: id,
        projectId: "prj-course-desk",
        expectedRevision: "rev-1",
        operations: [{ type: "approveDraft" }],
      },
    }),
  );
  return p;
}

function assertRefused(repo: string, pattern: RegExp) {
  const st = projectStatus(repo);
  assert.equal(st.state, "invalid", JSON.stringify(st.diagnostics));
  assert.match(st.diagnostics.map((d) => d.message).join("; "), pattern);
  for (const r of [listProposals(repo), previewProposal(repo, { changeId: "chg-evil" })]) {
    assert.equal(r.ok, false);
    assert.equal((r as { error: { code: string } }).error.code, "PROJECT_NOT_READY");
    assert.match((r as { error: { message: string } }).error.message, pattern);
  }
  // The writer agrees: it refuses to open rather than follow or block.
  assert.throws(
    () => new FileStore(join(repo, ".vcv")),
    (e: Error & { code?: string }) => e.code === "CORRUPT" && pattern.test(e.message),
  );
}

test("unsafe change-record entries are never followed or read: a symlink out of the checkout, a FIFO, an oversized file, a symlinked changes/ directory", () => {
  // Symlink to a valid-looking record outside the checkout.
  let repo = baseline();
  symlinkSync(outsideRecord("chg-evil"), join(repo, ".vcv/changes/chg-evil.json"));
  assertRefused(repo, /changes\/chg-evil\.json is a symlink, which is never followed/);

  // A FIFO would block a plain read forever; the test finishing is part of the assertion.
  repo = baseline();
  execFileSync("mkfifo", [join(repo, ".vcv/changes/chg-evil.json")]);
  assertRefused(repo, /changes\/chg-evil\.json is not a regular file/);

  // A directory named like a record.
  repo = baseline();
  mkdirSync(join(repo, ".vcv/changes/chg-evil.json"));
  assertRefused(repo, /changes\/chg-evil\.json is not a regular file/);

  // Oversized: refused by size before it is read into memory.
  repo = baseline();
  writeFileSync(join(repo, ".vcv/changes/chg-evil.json"), " ".repeat(STORE_FILE_LIMITS.change + 1));
  assertRefused(repo, /larger than/);

  // The whole changes/ directory replaced by a symlink to a directory outside the checkout.
  repo = baseline();
  const outside = mkdtempSync(join(tmpdir(), "vcv-outside-dir-"));
  writeFileSync(join(outside, "chg-evil.json"), readFileSync(outsideRecord("chg-evil")));
  renameSync(join(repo, ".vcv/changes"), join(repo, "changes-moved"));
  symlinkSync(outside, join(repo, ".vcv/changes"));
  assertRefused(repo, /changes\/ is a symlink/);

  // A symlinked revision file is refused the same way.
  repo = baseline();
  const rev = join(repo, ".vcv/revisions/rev-1.yaml");
  const copy = join(mkdtempSync(join(tmpdir(), "vcv-outside-rev-")), "rev-1.yaml");
  writeFileSync(copy, readFileSync(rev));
  renameSync(rev, join(repo, "rev-1.moved"));
  symlinkSync(copy, rev);
  assert.equal(projectStatus(repo).state, "invalid");
  assert.match(
    projectStatus(repo)
      .diagnostics.map((d) => d.message)
      .join(";"),
    /revisions\/rev-1\.yaml is a symlink/,
  );
});

test("a healthy project with records is ready and listing it is read-only; a readable record whose change is not typed is listed as invalid without disabling the project", () => {
  const repo = baseline();
  data(submitProposal(repo, cancellation(repo), agent));
  writeFileSync(
    join(repo, ".vcv/changes/chg-odd.json"),
    JSON.stringify({ changeId: "chg-odd", status: "pending", change: { patch: "/modules" } }),
  );
  assert.equal(projectStatus(repo).state, "ready");
  const before = storeHash(repo);
  const list = data(listProposals(repo));
  assert.deepEqual(list.counts, { pending: 1, stale: 0, rejected: 0, applied: 0, invalid: 1 });
  assert.equal(storeHash(repo), before);
});

// ---- one observation per call (review of PR #18) ----------------------------------------

test("preview and list refuse with STATE_CHANGED when a branch checkout or a record rewrite happens mid-read, and never mix generations", () => {
  const repo = baseline();
  data(submitProposal(repo, cancellation(repo), agent));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "pending proposal");
  // A feature branch whose model has moved on.
  git(repo, "checkout", "-q", "-b", "feature");
  assert.equal(
    new ModelEngine(new FileStore(join(repo, ".vcv"))).approve("chg-cancel-enrollment", reviewer).status,
    "applied",
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "approved");
  git(repo, "checkout", "-q", "main");

  const checkout = { afterRead: () => git(repo, "checkout", "-q", "feature") };
  for (const call of [
    () => previewProposal(repo, { changeId: "chg-cancel-enrollment" }, checkout),
    () => listProposals(repo, {}, checkout),
  ]) {
    git(repo, "checkout", "-q", "main");
    const r = call();
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
    assert.equal((r as { error: { code: string } }).error.code, "STATE_CHANGED");
  }

  // A record rewritten mid-read (same branch, no commit).
  git(repo, "checkout", "-q", "main");
  const rewrite = (r: string) => ({
    afterRead: () =>
      writeFileSync(
        join(repo, ".vcv/changes", `${r}.json`),
        readFileSync(join(repo, ".vcv/changes/chg-cancel-enrollment.json"), "utf8").replace(
          "agent:coder",
          "agent:someone",
        ),
      ),
  });
  assert.equal(
    (
      previewProposal(repo, { changeId: "chg-cancel-enrollment" }, rewrite("chg-cancel-enrollment")) as {
        error: { code: string };
      }
    ).error.code,
    "STATE_CHANGED",
  );
  git(repo, "checkout", "-q", "--", ".vcv");
  const added = {
    afterRead: () =>
      writeFileSync(
        join(repo, ".vcv/changes/chg-new.json"),
        JSON.stringify({ changeId: "chg-new", status: "pending", change: {} }),
      ),
  };
  assert.equal((listProposals(repo, {}, added) as { error: { code: string } }).error.code, "STATE_CHANGED");
  assert.equal(
    (previewProposal(repo, { changeId: "chg-nope" }, added) as { error: { code: string } }).error.code,
    "STATE_CHANGED",
    "even an UNKNOWN_CHANGE answer is only given for a stable observation",
  );

  // With nothing moving, the same calls answer from one generation: context and data agree.
  execFileSync("rm", ["-f", join(repo, ".vcv/changes/chg-new.json")]);
  const ok = data(previewProposal(repo, { changeId: "chg-cancel-enrollment" }, { afterRead: () => {} }));
  assert.equal(ok.proposal.lifecycle, "pending");
  const r = previewProposal(repo, { changeId: "chg-cancel-enrollment" }) as { context: { modelRevision: string } };
  assert.equal(r.context.modelRevision, "rev-1");
});
