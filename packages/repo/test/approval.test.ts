// Trusted reviewer approval, attestations and the read-only integrity check (Issue #17, M3.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dumpModel } from "../../ir/src/index.ts";
import { FileStore, ModelEngine, branchSafeRevisionId, proposalDigest } from "../../core/src/index.ts";
import type { HostContext, ProposedModelChange } from "../../core/src/index.ts";
import { ApprovalError, addTrustedReviewer, checkIntegrity, createReviewerKey, projectStatus, reviewApprove, submitProposal } from "../src/index.ts";
import type { IntegrityReport } from "../src/index.ts";
import { baseline, git } from "./course-desk.ts";

const agent: HostContext = { principalId: "agent:coder", permissions: ["model:propose"] };
const keys = mkdtempSync(join(tmpdir(), "vcv-keys-")); // outside every checkout
const keyFor = (id: string) => {
  const file = join(keys, `${id.replace(/[^a-z0-9]/gi, "_")}-${Math.random().toString(36).slice(2, 8)}.pem`);
  return { file, entry: createReviewerKey(id, file) };
};

/** Course Desk on main with a trusted reviewer committed, then a feature branch checked out. */
function setup() {
  const repo = baseline();
  const hoang = keyFor("user:hoang");
  addTrustedReviewer(repo, hoang.entry);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "trust user:hoang");
  git(repo, "checkout", "-q", "-b", "feature");
  return { repo, hoang };
}

const rev = (repo: string) => projectStatus(repo).model!.revision;
const change = (repo: string, id: string, ops: ProposedModelChange["operations"] = [{ type: "setDescription", objectId: "mod-web", description: `edited by ${id}` }]): ProposedModelChange => ({
  changeId: id,
  projectId: "prj-course-desk",
  expectedRevision: rev(repo),
  rationale: `test ${id}`,
  operations: ops,
});
function propose(repo: string, c: ProposedModelChange) {
  const r = submitProposal(repo, c, agent);
  assert.equal(r.ok && r.data.status, "pending", JSON.stringify(r));
  return proposalDigest(c);
}
const approve = (repo: string, id: string, digest: string, keyFile: string, trust = { kind: "git-ref" as const, ref: "HEAD" }) =>
  reviewApprove(repo, { changeId: id, expectedDigest: digest, keyFile, trust });
const codes = (r: IntegrityReport) => r.problems.map((p) => `${p.severity}:${p.code}`);
const storeHash = (repo: string) => {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  walk(join(repo, ".vcv"));
  return h.digest("hex");
};

test("golden path: agent proposes, a trusted reviewer approves the reviewed digest, VCV commits and attests; integrity verifies against the base; main still has the old model", () => {
  const { repo, hoang } = setup();
  const digest = propose(repo, change(repo, "chg-a"));
  const r = approve(repo, "chg-a", digest, hoang.file);
  assert.equal(r.outcome.status, "applied", JSON.stringify(r.outcome.diagnostics));
  assert.equal(r.reviewer.id, "user:hoang");
  assert.equal(r.outcome.record!.approverId, "user:hoang");
  assert.equal(r.attestation!.file, ".vcv/approvals/chg-a.json");
  const next = rev(repo);
  assert.equal(next, r.outcome.record!.resultingRevision);
  assert.equal(projectStatus(repo).model!.status, "draft", "approving a change does not approve the draft snapshot");

  const before = storeHash(repo);
  const report = checkIntegrity(repo, { base: "main", trust: { kind: "git-ref", ref: "main" }, requireAttestation: true });
  assert.equal(storeHash(repo), before, "the integrity check writes nothing");
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(codes(report), []);
  assert.deepEqual(report.revisions.map((c) => [c.revision, c.derivation, c.approval.state, c.introduced]), [
    ["rev-1", "initial", "not-applicable", false],
    [next, "verified", "attested", true],
  ]);
  assert.ok(report.limits.some((l) => /does not prove which person/.test(l)));

  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "approved model change");
  git(repo, "checkout", "-q", "main");
  assert.equal(rev(repo), "rev-1", "main still sees the old model");
  git(repo, "checkout", "-q", "feature");
  assert.equal(rev(repo), next, "the feature branch sees the approved revision, without regenerating anything");
  // A simulated local merge: main fast-forwards and now reads the merged revision as is.
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--ff-only", "feature");
  assert.equal(rev(repo), next);
  assert.equal(checkIntegrity(repo, { trust: { kind: "git-ref", ref: "HEAD~1" }, requireAttestation: true }).ok, true, "trust from the commit before the merge");
});

test("the reviewer step refuses: a wrong digest, an untrusted key, self-approval, a stale proposal, a replay and an unknown change; none moves HEAD wrongly", () => {
  const { repo, hoang } = setup();
  const digest = propose(repo, change(repo, "chg-a"));
  propose(repo, change(repo, "chg-b"));

  // The record was edited after the preview: the reviewed digest no longer matches.
  const recPath = join(repo, ".vcv/changes/chg-a.json");
  const original = readFileSync(recPath, "utf8");
  writeFileSync(recPath, original.replace('"rationale": "test chg-a"', '"rationale": "something else"'));
  const mismatch = approve(repo, "chg-a", digest, hoang.file);
  assert.equal(mismatch.outcome.diagnostics[0]!.code, "DIGEST_MISMATCH");
  assert.equal(JSON.parse(readFileSync(recPath, "utf8")).status, "pending");
  assert.equal(rev(repo), "rev-1");
  writeFileSync(recPath, original);

  // A key that is not in the committed trust list.
  const stranger = keyFor("agent:coder");
  assert.throws(() => approve(repo, "chg-a", digest, stranger.file), (e: ApprovalError) => e.code === "UNTRUSTED_KEY");

  // A trusted reviewer whose principal is the proposer cannot approve their own change.
  const self = keyFor("agent:coder");
  git(repo, "checkout", "-q", "main");
  addTrustedReviewer(repo, self.entry);
  git(repo, "add", ".vcv/reviewers.json");
  git(repo, "commit", "-q", "-m", "trust a second key");
  git(repo, "checkout", "-q", "feature");
  git(repo, "merge", "-q", "main");
  assert.equal(approve(repo, "chg-a", digest, self.file).outcome.diagnostics[0]!.code, "SELF_APPROVAL");
  assert.equal(rev(repo), "rev-1");

  assert.equal(approve(repo, "chg-a", digest, hoang.file).outcome.status, "applied");
  assert.equal(approve(repo, "chg-a", digest, hoang.file).outcome.diagnostics[0]!.code, "NOT_PENDING", "a replayed approval is refused");
  const stale = approve(repo, "chg-b", proposalDigest(JSON.parse(readFileSync(join(repo, ".vcv/changes/chg-b.json"), "utf8")).change), hoang.file);
  assert.equal(stale.outcome.status, "rejected");
  assert.equal(stale.outcome.diagnostics[0]!.code, "STALE_REVISION", "approval is rechecked against the current revision");
  assert.equal(approve(repo, "chg-nope", digest, hoang.file).outcome.diagnostics[0]!.code, "UNKNOWN_CHANGE");
  assert.throws(() => approve(repo, "chg-a", "abc", hoang.file), (e: ApprovalError) => e.code === "INVALID_DIGEST");
});

test("an agent that adds its own key to the working tree can sign locally, but integrity against the protected base calls it untrusted", () => {
  const { repo } = setup();
  const digest = propose(repo, change(repo, "chg-a"));
  const own = keyFor("user:fake-reviewer");
  addTrustedReviewer(repo, own.entry); // uncommitted, in the checkout under review
  // Default trust (the committed HEAD) does not list it.
  assert.throws(() => approve(repo, "chg-a", digest, own.file), (e: ApprovalError) => e.code === "UNTRUSTED_KEY");
  // Trusting the working tree works locally: that is the reviewer's choice, and it is reported.
  assert.equal(approve(repo, "chg-a", digest, own.file, { kind: "working-tree" } as never).outcome.status, "applied");

  const lax = checkIntegrity(repo, { trust: { kind: "working-tree" } });
  assert.equal(lax.revisions[1]!.approval.state, "attested");
  assert.ok(codes(lax).includes("warning:TRUST_FROM_CHECKOUT"));

  const strict = checkIntegrity(repo, { base: "main", trust: { kind: "git-ref", ref: "main" }, requireAttestation: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.revisions[1]!.approval.state, "untrusted-key");
  assert.ok(codes(strict).includes("error:APPROVAL_NOT_ATTESTED"));
});

test("a direct apply or developer approval has unknown provenance: a warning by default, an error with --require-attestation; never 'attested'", () => {
  const { repo } = setup();
  const out = new ModelEngine(new FileStore(join(repo, ".vcv"))).propose(change(repo, "chg-direct"), { principalId: "user:dev", permissions: ["model:propose", "model:apply"] });
  assert.equal(out.status, "applied");
  const loose = checkIntegrity(repo, { base: "main", trust: { kind: "git-ref", ref: "main" } });
  assert.equal(loose.ok, true);
  assert.equal(loose.revisions[1]!.derivation, "verified", "the revision is still operation-derived");
  assert.equal(loose.revisions[1]!.approval.state, "missing");
  assert.ok(codes(loose).includes("warning:APPROVAL_NOT_ATTESTED"));
  const strict = checkIntegrity(repo, { base: "main", trust: { kind: "git-ref", ref: "main" }, requireAttestation: true });
  assert.equal(strict.ok, false);
  assert.ok(codes(strict).includes("error:APPROVAL_NOT_ATTESTED"));
  assert.equal(checkIntegrity(repo).revisions[1]!.approval.state, "missing");
});

test("hand-made or edited history fails integrity: an unexplained revision, a forged record, an edited attestation, an edited HEAD record, a rewritten base", () => {
  // 1. A new revision written by hand, with a valid branch-safe ID and HEAD, but no change record.
  {
    const { repo } = setup();
    const store = join(repo, ".vcv");
    const m = new FileStore(store).current();
    m.modules.find((x) => x.id === "mod-web")!.description = "hand-written";
    const id = branchSafeRevisionId(m, "rev-1", 2);
    m.project.modelRevision = id;
    writeFileSync(join(store, "revisions", `${id}.yaml`), dumpModel(m));
    const head = JSON.parse(readFileSync(join(store, "HEAD"), "utf8"));
    writeFileSync(join(store, "HEAD"), JSON.stringify({ ...head, revision: id, history: [...head.history, id] }, null, 2));
    assert.equal(projectStatus(repo).state, "ready", "the store itself is well-formed");
    const r = checkIntegrity(repo, { base: "main" });
    assert.equal(r.ok, false);
    assert.ok(codes(r).includes("error:UNEXPLAINED_REVISION"));
    assert.equal(r.revisions[1]!.derivation, "no-record");
  }
  // 2. An approved change whose record is then edited to claim different operations.
  {
    const { repo, hoang } = setup();
    const digest = propose(repo, change(repo, "chg-a"));
    approve(repo, "chg-a", digest, hoang.file);
    const p = join(repo, ".vcv/changes/chg-a.json");
    const rec = JSON.parse(readFileSync(p, "utf8"));
    rec.change.operations[0].description = "something the reviewer never saw";
    writeFileSync(p, JSON.stringify(rec, null, 2));
    const r = checkIntegrity(repo, { base: "main", trust: { kind: "git-ref", ref: "main" } });
    assert.ok(codes(r).includes("error:DERIVATION_MISMATCH"));
    assert.equal(r.revisions[1]!.approval.state, "invalid", "the attestation no longer matches the record's digest");
    assert.match(r.revisions[1]!.approval.detail, /proposalDigest/);
  }
  // 3. An attestation edited to name another approver.
  {
    const { repo, hoang } = setup();
    approve(repo, "chg-a", propose(repo, change(repo, "chg-a")), hoang.file);
    const ap = join(repo, ".vcv/approvals/chg-a.json");
    writeFileSync(ap, readFileSync(ap, "utf8").replaceAll("user:hoang", "user:someone"));
    const rp = join(repo, ".vcv/changes/chg-a.json");
    writeFileSync(rp, readFileSync(rp, "utf8").replaceAll("user:hoang", "user:someone"));
    const r = checkIntegrity(repo, { base: "main", trust: { kind: "git-ref", ref: "main" }, requireAttestation: true });
    assert.equal(r.revisions[1]!.approval.state, "invalid");
    assert.equal(r.revisions[1]!.approval.detail, "signature does not verify");
    assert.equal(r.ok, false);
  }
  // 4. HEAD's last commit edited.
  {
    const { repo, hoang } = setup();
    approve(repo, "chg-a", propose(repo, change(repo, "chg-a")), hoang.file);
    const hp = join(repo, ".vcv/HEAD");
    const head = JSON.parse(readFileSync(hp, "utf8"));
    head.lastCommit.approverId = "user:someone";
    writeFileSync(hp, JSON.stringify(head, null, 2));
    assert.ok(codes(checkIntegrity(repo)).includes("error:HEAD_RECORD_MISMATCH"));
  }
  // 5. A committed revision file edited: the store itself refuses it.
  {
    const { repo, hoang } = setup();
    approve(repo, "chg-a", propose(repo, change(repo, "chg-a")), hoang.file);
    const f = join(repo, ".vcv/revisions", `${rev(repo)}.yaml`);
    writeFileSync(f, readFileSync(f, "utf8").replace("edited by chg-a", "edited later"));
    const r = checkIntegrity(repo);
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r), ["error:STORE_NOT_READY"]);
  }
  // 6. The base history replaced: a branch that re-created .vcv/ from scratch.
  {
    const { repo } = setup();
    const m = new FileStore(join(repo, ".vcv")).current();
    m.project.description = "re-initialized";
    git(repo, "rm", "-rq", ".vcv");
    FileStore.init(join(repo, ".vcv"), m);
    const r = checkIntegrity(repo, { base: "main" });
    assert.ok(codes(r).includes("error:BASE_REVISION_CHANGED"), JSON.stringify(codes(r)));
  }
});

test("change approval and snapshot approval stay separate: approveDraft is itself a change that only a reviewer can apply", () => {
  const { repo, hoang } = setup();
  const d1 = propose(repo, change(repo, "chg-describe"));
  approve(repo, "chg-describe", d1, hoang.file);
  assert.equal(projectStatus(repo).model!.status, "draft");
  const d2 = propose(repo, change(repo, "chg-approve-draft", [{ type: "approveDraft" }]));
  assert.equal(projectStatus(repo).model!.status, "draft", "a pending approveDraft changes nothing");
  assert.equal(approve(repo, "chg-approve-draft", d2, hoang.file).outcome.status, "applied");
  assert.equal(projectStatus(repo).model!.status, "approved");
  const r = checkIntegrity(repo, { base: "main", trust: { kind: "git-ref", ref: "main" }, requireAttestation: true });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.revisions.length, 3);
});
