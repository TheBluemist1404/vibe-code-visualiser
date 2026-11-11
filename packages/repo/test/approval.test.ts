// Trusted reviewer approval, attestations and the read-only integrity check (Issue #17, M3.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { dumpModel } from "../../ir/src/index.ts";
import { FileStore, ModelEngine, branchSafeRevisionId, proposalDigest } from "../../core/src/index.ts";
import type { HostContext, ProposedModelChange } from "../../core/src/index.ts";
import { ApprovalError, addTrustedReviewer, checkIntegrity, createReviewerKey, loadTrust, projectStatus, reviewApprove, reviewFinalize, submitProposal } from "../src/index.ts";
import type { IntegrityReport, ReviewApproveInput, TrustSource } from "../src/index.ts";
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
const MAIN: TrustSource = { kind: "git-ref", ref: "main" };
const approve = (repo: string, id: string, digest: string, keyFile: string, trust: TrustSource = MAIN, extra: Partial<ReviewApproveInput> = {}) =>
  reviewApprove(repo, { changeId: id, expectedDigest: digest, keyFile, trust, ...extra });
const finalize = (repo: string, id: string, digest: string, keyFile: string, trust: TrustSource = MAIN) => reviewFinalize(repo, { changeId: id, expectedDigest: digest, keyFile, trust });
const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: ApprovalError) => (assert.equal(e.code, code, e.message), true));
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
  // On main itself, main is the checked-out branch, so it cannot anchor trust for a strict check;
  // a ref the checkout does not control (here the feature branch's parent commit) can.
  assert.ok(codes(checkIntegrity(repo, { trust: MAIN, requireAttestation: true })).includes("error:TRUST_FROM_CHECKOUT"));
  assert.equal(checkIntegrity(repo, { trust: { kind: "git-ref", ref: "feature~1" }, requireAttestation: true }).ok, true, "trust from the commit before the merge");
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

test("an agent that commits its own key on the feature branch cannot anchor trust there: default-free review refuses, strict integrity rejects self-controlled trust", () => {
  const { repo } = setup();
  const digest = propose(repo, change(repo, "chg-a"));
  const own = keyFor("user:fake-reviewer");
  addTrustedReviewer(repo, own.entry);
  git(repo, "add", ".vcv/reviewers.json");
  git(repo, "commit", "-q", "-m", "agent trusts itself");

  // Every spelling of the candidate branch is refused as a trust anchor, before anything is applied.
  for (const ref of ["HEAD", "@", "HEAD~0", "feature", "refs/heads/feature", "feature~0"]) {
    throwsCode(() => approve(repo, "chg-a", digest, own.file, { kind: "git-ref", ref }), "UNPROTECTED_TRUST");
  }
  // A commit only the feature branch contains is the candidate too, whatever it is called.
  const sha = git(repo, "rev-parse", "HEAD");
  throwsCode(() => approve(repo, "chg-a", digest, own.file, { kind: "git-ref", ref: sha }), "UNPROTECTED_TRUST");
  throwsCode(() => approve(repo, "chg-a", digest, own.file, { kind: "working-tree" }), "UNPROTECTED_TRUST");
  // Trust files inside the checkout, however spelled (relative, ../, through a symlinked parent).
  const inTree = join(repo, ".vcv/reviewers.json");
  const link = join(mkdtempSync(join(tmpdir(), "vcv-link-")), "store");
  symlinkSync(join(repo, ".vcv"), link);
  for (const path of [inTree, relative(process.cwd(), inTree), join(repo, ".vcv/../.vcv/reviewers.json"), join(link, "reviewers.json")]) {
    const t = loadTrust(repo, { kind: "file", path });
    assert.equal(t.protectedFromCheckout, false, path);
    throwsCode(() => approve(repo, "chg-a", digest, own.file, { kind: "file", path }), "UNPROTECTED_TRUST");
  }
  // The protected base does not list the agent's key.
  throwsCode(() => approve(repo, "chg-a", digest, own.file), "UNTRUSTED_KEY");
  assert.equal(rev(repo), "rev-1", "nothing was applied");
  assert.equal(JSON.parse(readFileSync(join(repo, ".vcv/changes/chg-a.json"), "utf8")).status, "pending");
  // A file outside the checkout is an external anchor (its integrity is the caller's).
  const outside = join(mkdtempSync(join(tmpdir(), "vcv-trust-")), "reviewers.json");
  writeFileSync(outside, readFileSync(inTree));
  assert.equal(loadTrust(repo, { kind: "file", path: outside }).protectedFromCheckout, true);
  assert.match(loadTrust(repo, MAIN).anchor, /local branch main pinned at [0-9a-f]{12}; branch protection is asserted .* not verified by Git/);

  // Explicit unsafe development mode: applied and signed, but not a trusted approval.
  assert.equal(approve(repo, "chg-a", digest, own.file, { kind: "working-tree" }, { allowUnprotectedTrust: true }).outcome.status, "applied");
  const lax = checkIntegrity(repo, { trust: { kind: "working-tree" } });
  assert.equal(lax.revisions[1]!.approval.state, "attested");
  assert.ok(codes(lax).includes("warning:TRUST_FROM_CHECKOUT"));
  for (const trust of [{ kind: "working-tree" }, { kind: "git-ref", ref: "HEAD" }, { kind: "file", path: inTree }] as TrustSource[]) {
    const strict = checkIntegrity(repo, { base: "main", trust, requireAttestation: true });
    assert.equal(strict.ok, false, JSON.stringify(trust));
    assert.ok(codes(strict).includes("error:TRUST_FROM_CHECKOUT"), JSON.stringify(codes(strict)));
  }
  const strict = checkIntegrity(repo, { base: "main", trust: MAIN, requireAttestation: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.revisions[1]!.approval.state, "untrusted-key");
  assert.ok(codes(strict).includes("error:APPROVAL_NOT_ATTESTED"));
});

test("the attestation destination is checked before anything is committed, and a failed write after the commit is recoverable by the approver only", () => {
  // Unsafe destination: refused before the engine runs.
  {
    const { repo, hoang } = setup();
    const digest = propose(repo, change(repo, "chg-a"));
    const elsewhere = mkdtempSync(join(tmpdir(), "vcv-elsewhere-"));
    symlinkSync(elsewhere, join(repo, ".vcv/approvals"));
    throwsCode(() => approve(repo, "chg-a", digest, hoang.file), "UNSAFE_PATH");
    assert.equal(rev(repo), "rev-1");
    assert.equal(readdirSync(elsewhere).length, 0);
    unlinkSync(join(repo, ".vcv/approvals"));
    writeFileSync(join(repo, ".vcv/approvals"), "not a directory");
    throwsCode(() => approve(repo, "chg-a", digest, hoang.file), "UNSAFE_PATH");
    unlinkSync(join(repo, ".vcv/approvals"));
    // A pre-existing attestation for this change is never overwritten.
    mkdirSync(join(repo, ".vcv/approvals"));
    writeFileSync(join(repo, ".vcv/approvals/chg-a.json"), "{}");
    throwsCode(() => approve(repo, "chg-a", digest, hoang.file), "ATTESTATION_EXISTS");
    assert.equal(rev(repo), "rev-1");
    assert.equal(readFileSync(join(repo, ".vcv/approvals/chg-a.json"), "utf8"), "{}");
  }
  // A crash between the model commit and the attestation write.
  {
    const { repo, hoang } = setup();
    const lan = keyFor("user:lan");
    git(repo, "checkout", "-q", "main");
    addTrustedReviewer(repo, lan.entry);
    git(repo, "commit", "-qam", "trust user:lan");
    git(repo, "checkout", "-q", "feature");
    git(repo, "merge", "-q", "main");
    const digest = propose(repo, change(repo, "chg-a"));
    assert.throws(
      () => approve(repo, "chg-a", digest, hoang.file, MAIN, { afterCommit: () => { throw new Error("simulated crash"); } }),
      (e: ApprovalError) => e.code === "ATTESTATION_NOT_WRITTEN" && /simulated crash/.test(e.message) && /vcv review finalize .* chg-a --digest [0-9a-f]{64}/.test(e.message),
    );
    const applied = rev(repo);
    assert.notEqual(applied, "rev-1", "the model commit happened");
    assert.equal(existsSync(join(repo, ".vcv/approvals/chg-a.json")), false);
    assert.equal(approve(repo, "chg-a", digest, hoang.file).outcome.diagnostics[0]!.code, "NOT_PENDING", "approval cannot be repeated");
    const blocked = checkIntegrity(repo, { base: "main", trust: MAIN, requireAttestation: true });
    assert.ok(codes(blocked).includes("error:APPROVAL_NOT_ATTESTED"));

    // Recovery: only the recorded approver, with a trusted key, for the reviewed digest.
    throwsCode(() => finalize(repo, "chg-a", digest, lan.file), "NOT_APPROVER");
    throwsCode(() => finalize(repo, "chg-a", "0".repeat(64), hoang.file), "DIGEST_MISMATCH");
    throwsCode(() => finalize(repo, "chg-a", digest, hoang.file, { kind: "git-ref", ref: "HEAD" }), "UNPROTECTED_TRUST");
    throwsCode(() => finalize(repo, "chg-a", digest, keyFor("user:hoang").file), "UNTRUSTED_KEY");
    throwsCode(() => finalize(repo, "chg-nope", digest, hoang.file), "UNKNOWN_CHANGE");
    const before = readFileSync(join(repo, ".vcv/HEAD"), "utf8");
    const done = finalize(repo, "chg-a", digest, hoang.file);
    assert.equal(done.attestation!.file, ".vcv/approvals/chg-a.json");
    assert.equal(readFileSync(join(repo, ".vcv/HEAD"), "utf8"), before, "finalize writes only the attestation");
    assert.equal(rev(repo), applied);
    const fixed = checkIntegrity(repo, { base: "main", trust: MAIN, requireAttestation: true });
    assert.equal(fixed.ok, true, JSON.stringify(fixed.problems));
    // Idempotent for the same reviewer; never replaces a different attestation.
    const file = readFileSync(join(repo, ".vcv/approvals/chg-a.json"), "utf8");
    assert.equal(finalize(repo, "chg-a", digest, hoang.file).attestation!.alreadyPresent, true);
    assert.equal(readFileSync(join(repo, ".vcv/approvals/chg-a.json"), "utf8"), file);
    writeFileSync(join(repo, ".vcv/approvals/chg-a.json"), file.replace(/"signedAt": "[^"]+"/, '"signedAt": "2000-01-01T00:00:00.000Z"'));
    throwsCode(() => finalize(repo, "chg-a", digest, hoang.file), "ATTESTATION_EXISTS");
  }
  // finalize never applies a pending change.
  {
    const { repo, hoang } = setup();
    const digest = propose(repo, change(repo, "chg-a"));
    throwsCode(() => finalize(repo, "chg-a", digest, hoang.file), "NOT_APPLIED");
    assert.equal(rev(repo), "rev-1");
  }
});

test("a branch cannot drop or rewrite the base's approval evidence: removed or edited attestations and settled records fail the base check", () => {
  const { repo, hoang } = setup();
  approve(repo, "chg-a", propose(repo, change(repo, "chg-a")), hoang.file);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "approved chg-a");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--ff-only", "feature");
  git(repo, "checkout", "-q", "-b", "feature-2");
  const strict = () => checkIntegrity(repo, { base: "main", trust: MAIN, requireAttestation: true });
  assert.equal(strict().ok, true, JSON.stringify(strict().problems));

  const att = join(repo, ".vcv/approvals/chg-a.json");
  const attText = readFileSync(att, "utf8");
  rmSync(att);
  const removed = strict();
  assert.equal(removed.ok, false);
  assert.ok(codes(removed).includes("error:BASE_EVIDENCE_REMOVED"), JSON.stringify(codes(removed)));
  assert.equal(removed.revisions[1]!.introduced, false);
  assert.equal(checkIntegrity(repo, { base: "main" }).ok, false, "an error even without --require-attestation");
  writeFileSync(att, attText);

  const rec = join(repo, ".vcv/changes/chg-a.json");
  const recText = readFileSync(rec, "utf8");
  writeFileSync(rec, recText.replace("\n}", "\n }"));
  assert.ok(codes(strict()).includes("error:BASE_EVIDENCE_CHANGED"), JSON.stringify(codes(strict())));
  writeFileSync(rec, recText);
  assert.equal(strict().ok, true);
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
