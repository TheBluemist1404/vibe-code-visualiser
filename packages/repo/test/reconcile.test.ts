// Pre-merge candidate/base reconciliation baseline (Issue #22, M4.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, ModelEngine } from "../../core/src/index.ts";
import type { HostContext } from "../../core/src/index.ts";
import {
  RECONCILE_LIMITS,
  addTrustedReviewer,
  createReviewerKey,
  previewProposal,
  projectStatus,
  reconcile,
  reviewApprove,
  submitProposal,
} from "../src/index.ts";
import type { Reconciliation } from "../src/index.ts";
import { SERVICE, baseline, edit, git } from "./course-desk.ts";

const dev: HostContext = { principalId: "user:dev", permissions: ["model:propose", "model:apply"] };

/** Course Desk baseline on main, a feature branch checked out, and main's commit ID (what a host passes). */
function setup() {
  const repo = baseline();
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "feature");
  return { repo, base };
}

function ok(repo: string, base: string, hooks = {}): Reconciliation {
  const r = reconcile(repo, { base }, hooks);
  assert.ok(r.ok, JSON.stringify(r));
  return r.data;
}
const codes = (d: Reconciliation) => d.findings.map((f) => f.code);
const finding = (d: Reconciliation, code: string, bindingId?: string) =>
  d.findings.find((f) => f.code === code && (bindingId === undefined || f.bindingId === bindingId));

// The code-first defect M4.5 will demonstrate: the rejection is no longer announced.
const DROP_REJECTION_NOTICE =
  /if \(reason\) \{\s*this\.notifications\.notify\([\s\S]*?\);\s*\} else \{\s*(this\.notifications\.notify\(enrollment\.studentId, "enrollment-confirmed"[^;]*;)\s*\}/;

test("code-first change: bound code moved, claims are stale, nothing is called drift or a contradiction", () => {
  const { repo, base } = setup();
  edit(repo, SERVICE, DROP_REJECTION_NOTICE, "if (!reason) {\n      $1\n    }");
  git(repo, "commit", "-qam", "notify confirmations only");
  appendFileSync(join(repo, "README.md"), "\nlocal note\n"); // an uncommitted, unrelated edit

  const d = ok(repo, base);
  assert.equal(d.format, "vcv-reconciliation-1");
  assert.equal(d.base.pinned, true);
  assert.equal(d.base.containedInCandidate, true);
  assert.equal(d.model.lineage, "unchanged");
  assert.equal(d.model.integrity.ok, true);
  assert.equal(d.model.delta.total, 0);
  assert.equal(d.implementationChecked, false);
  assert.deepEqual(d.semantic.observations, []);

  const svc = d.source.files.find((f) => f.path === SERVICE)!;
  assert.deepEqual([svc.area, svc.committed, svc.uncommitted], ["source", true, false]);
  assert.deepEqual(svc.bindings, ["impl.cap-enroll", "impl.rul-seat-limit"]);
  assert.deepEqual(svc.objectIds, ["cap-enroll", "rul-seat-limit"]);
  const readme = d.source.files.find((f) => f.path === "README.md")!;
  assert.deepEqual([readme.committed, readme.uncommitted, readme.bindings], [false, true, []]);
  assert.equal(d.candidate.dirty, true);

  for (const id of ["impl.cap-enroll", "impl.rul-seat-limit"]) {
    const f = finding(d, "CLAIM_STALE", id)!;
    assert.ok(f, `${id} is stale`);
    assert.deepEqual([f.category, f.basis, f.related], ["binding", "checked", true]);
    assert.match(f.message, /whether it still does what the model says is for an agent or a person to judge/);
    const row = d.bindings.items.find((b) => b.bindingId === id)!;
    assert.deepEqual(
      [row.state, row.atBase, row.boundFileChanged, row.object, row.source?.state, row.model?.state],
      ["stale", "unchanged", true, "unchanged", "changed", "unchanged"],
    );
  }
  assert.ok(finding(d, "BOUND_FILE_CHANGED"));
  assert.equal(finding(d, "BOUND_FILE_CHANGED")!.basis, "observed");
  const unmapped = finding(d, "UNMAPPED_CHANGES")!;
  assert.deepEqual([unmapped.category, unmapped.basis], ["unsupported", "not-checked"]);
  assert.match(unmapped.message, /README\.md/);
  assert.ok(finding(d, "UNCOMMITTED_CHANGES"));
  // The route and test claims point at unchanged code: counted, not listed.
  assert.equal(d.bindings.unaffected, 2);
  assert.equal(d.summary.structural, 0);
  assert.equal(d.summary.staleClaims, 2);
  assert.equal(d.summary.unmappedFiles, 1);
  assert.ok(!d.findings.some((f) => f.category === "structural" || f.category === "integrity"));

  // No model delta, so no model impact; the source side still gets declared-model context.
  assert.equal(d.model.impact, null);
  const si = d.sourceImpact!;
  assert.equal(si.impactClass, "declared-model-context");
  assert.deepEqual(
    si.seeds.map((x) => x.objectId),
    ["cap-enroll", "rul-seat-limit"],
  );
  assert.deepEqual(si.seeds[0]!.why, ["bound-file-changed"]);
  assert.deepEqual(si.seeds[0]!.bindings, ["impl.cap-enroll"]);
  assert.ok(
    si.modules.some((m) => m.id === "mod-enrollment" && m.via === "seed"),
    JSON.stringify(si.modules),
  );
  assert.ok(si.rules.some((r) => r.id === "rul-seat-limit" && r.via === "seed"));
  assert.ok(si.candidates.length > 0, "the declared model has dependents of enrollment");
  assert.match(si.note, /not evidence that behaviour changed/);
});

test("a harmless edit in a bound file is observed, not reported as a stale claim", () => {
  const { repo, base } = setup();
  edit(repo, SERVICE, "Enrollment rules. Every decision", "Enrollment rules (see docs). Every decision");
  const d = ok(repo, base);
  assert.ok(finding(d, "BOUND_FILE_CHANGED"));
  assert.equal(d.summary.staleClaims, 0);
  assert.ok(!codes(d).includes("CLAIM_STALE"));
  const row = d.bindings.items.find((b) => b.bindingId === "impl.cap-enroll")!;
  assert.deepEqual([row.state, row.source?.fileChanged], ["resolved", true]);
  // Where to look, still offered as context, and still not a contradiction.
  assert.ok(d.sourceImpact?.seeds.some((x) => x.objectId === "cap-enroll"));
  assert.ok(
    !d.findings.some((f) => f.category === "structural" || f.category === "integrity" || f.code === "CLAIM_STALE"),
  );
});

test("model-first change: lineage, delta, impact, unattested approval and unbound new objects", () => {
  const { repo, base } = setup();
  const engine = new ModelEngine(new FileStore(join(repo, ".vcv")));
  const out = engine.propose(
    {
      changeId: "chg-cancel",
      projectId: "prj-course-desk",
      expectedRevision: projectStatus(repo).model!.revision,
      operations: [
        {
          type: "setRuleStatement",
          ruleId: "rul-seat-limit",
          statement:
            "Confirmed enrollments never exceed capacity; a full course is rejected with COURSE_FULL and the student is told the capacity.",
        },
        {
          type: "createCapability",
          capability: {
            id: "cap-cancel-enrollment",
            kind: "capability",
            owner: "mod-enrollment",
            name: "Cancel enrollment",
            initiatorActorId: "act-student",
          },
        },
      ],
    },
    dev,
  );
  assert.equal(out.status, "applied", JSON.stringify(out));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "model: cancel enrollment");

  const d = ok(repo, base);
  assert.equal(d.model.lineage, "extends");
  assert.equal(d.model.introduced.length, 1);
  assert.deepEqual(
    [d.model.introduced[0]!.changeId, d.model.introduced[0]!.derivation, d.model.introduced[0]!.approval],
    ["chg-cancel", "verified", "missing"],
  );
  assert.equal(d.model.integrity.ok, true, "unattested is a warning without --require-attestation");
  assert.ok(d.model.integrity.warnings.some((w) => w.code === "APPROVAL_NOT_ATTESTED"));
  const changed = d.model.delta.changes.map((c) => `${c.change}:${c.id}`).sort();
  assert.ok(
    changed.includes("modified:rul-seat-limit") && changed.includes("added:cap-cancel-enrollment"),
    changed.join(),
  );
  assert.ok(d.model.impact);
  assert.ok(d.source.files.some((f) => f.area === "vcv-model"));
  // A claim on a changed object is stale on the model axis.
  const seat = d.bindings.items.find((b) => b.bindingId === "impl.rul-seat-limit")!;
  assert.deepEqual([seat.state, seat.object, seat.model?.state], ["stale", "modified", "changed"]);
  const unbound = d.findings.filter((f) => f.code === "OBJECT_UNBOUND").flatMap((f) => f.objectIds);
  assert.ok(unbound.includes("cap-cancel-enrollment"));
  assert.ok(!unbound.includes("rul-seat-limit"), "rul-seat-limit has claims");

  // Strict: the unattested revision is an integrity error, labelled as checked.
  const strict = reconcile(repo, { base, requireAttestation: true });
  assert.ok(strict.ok);
  const f = strict.data.findings.find((x) => x.code === "APPROVAL_NOT_ATTESTED")!;
  assert.deepEqual([f.category, f.basis, f.revision !== undefined], ["integrity", "checked", true]);
  assert.equal(strict.data.summary.integrity, "failed");
});

test("a hand-edited revision is an integrity failure, reported with the revision", () => {
  const { repo, base } = setup();
  const rev = projectStatus(repo).model!.revision;
  edit(repo, `.vcv/revisions/${rev}.yaml`, /name: Enrollment\b/, "name: Enrolment");
  const d = ok(repo, base);
  assert.equal(d.model.lineage, "rewritten");
  assert.equal(d.summary.integrity, "failed");
  const f = finding(d, "BASE_REVISION_CHANGED")!;
  assert.deepEqual([f.category, f.basis, f.revision], ["integrity", "checked", rev]);
  // The delta shows exactly what the hand edit changed, against the base's copy.
  assert.ok(d.model.delta.changes.some((c) => c.id === "mod-enrollment" && c.fields.some((x) => x.field === "name")));
});

test("removed claims, claims on objects the model lacks, and invalid claim files", () => {
  const { repo, base } = setup();
  git(repo, "rm", "-q", ".vcv/bindings/expose.cap-enroll.json");
  git(repo, "commit", "-qm", "drop the route claim");
  const ghost = JSON.parse(git(repo, "show", "HEAD:.vcv/bindings/impl.cap-enroll.json"));
  writeFileSync(
    join(repo, ".vcv/bindings/impl.ghost.json"),
    JSON.stringify({ ...ghost, bindingId: "impl.ghost", modelObjectId: "cap-ghost" }, null, 2),
  );
  writeFileSync(join(repo, ".vcv/bindings/broken.json"), "{ not json");

  const d = ok(repo, base);
  const removed = finding(d, "CLAIM_REMOVED", "expose.cap-enroll")!;
  assert.deepEqual([removed.category, removed.basis], ["binding", "observed"]);
  assert.equal(d.bindings.items.find((b) => b.bindingId === "expose.cap-enroll")!.atBase, "removed");
  const contra = finding(d, "CLAIM_ON_MISSING_OBJECT", "impl.ghost")!;
  assert.deepEqual([contra.category, contra.basis, contra.objectIds], ["structural", "checked", ["cap-ghost"]]);
  assert.equal(d.bindings.items.find((b) => b.bindingId === "impl.ghost")!.atBase, "added");
  assert.equal(finding(d, "CLAIM_INVALID", "broken")!.basis, "checked");
  assert.equal(d.summary.structural, 1);
  assert.equal(d.summary.removedClaims, 1);
  assert.equal(d.findings[0]!.category, "structural", "structural findings sort before binding and source facts");
});

test("a base the candidate does not contain is measured from the merge base, and a ref name is not pinned", () => {
  const { repo, base } = setup();
  edit(repo, SERVICE, "Enrollment rules. Every decision", "Enrollment rules (feature). Every decision");
  git(repo, "commit", "-qam", "feature edit");
  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "MAIN.md"), "landed on main later\n");
  git(repo, "add", "MAIN.md");
  git(repo, "commit", "-qm", "main moves on");
  const tip = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "feature");

  const d = ok(repo, "main");
  assert.equal(d.base.pinned, false);
  assert.equal(d.base.commit, tip);
  assert.equal(d.base.mergeBase, base);
  assert.equal(d.base.containedInCandidate, false);
  assert.ok(finding(d, "BASE_NOT_CONTAINED"));
  assert.ok(!d.source.files.some((f) => f.path === "MAIN.md"), "a change on the base is not the candidate's");
  assert.ok(d.source.files.some((f) => f.path === SERVICE));
});

test("a base without .vcv/ gives lineage new-model", () => {
  const { repo } = setup();
  const before = git(repo, "rev-parse", "HEAD~1");
  const d = ok(repo, before);
  assert.equal(d.model.lineage, "new-model");
  assert.equal(d.base.modelRevision, null);
  assert.ok(finding(d, "MODEL_INTRODUCED"));
});

test("coherency: a dirty same-path edit, a branch flip or a moved base ref mid-read is STATE_CHANGED", () => {
  const { repo, base } = setup();
  let once = true;
  const flip = (fn: () => void) => ({ afterRead: () => (once ? ((once = false), fn()) : undefined) });

  const r1 = reconcile(
    repo,
    { base },
    flip(() => edit(repo, SERVICE, "Enrollment rules. Every decision", "Enrollment rules! Every decision")),
  );
  assert.equal(!r1.ok && r1.error.code, "STATE_CHANGED");

  git(repo, "checkout", "-q", "--", SERVICE);
  git(repo, "checkout", "-q", "-b", "other");
  edit(repo, SERVICE, "Enrollment rules. Every decision", "Enrollment rules? Every decision");
  git(repo, "commit", "-qam", "other");
  git(repo, "checkout", "-q", "feature");
  once = true;
  const r2 = reconcile(
    repo,
    { base },
    flip(() => git(repo, "checkout", "-q", "other")),
  );
  assert.equal(!r2.ok && r2.error.code, "STATE_CHANGED");

  git(repo, "checkout", "-q", "feature");
  git(repo, "branch", "-q", "trunk", base);
  once = true;
  const r3 = reconcile(
    repo,
    { base: "trunk" },
    flip(() => git(repo, "branch", "-qf", "trunk", git(repo, "rev-parse", "other"))),
  );
  assert.equal(!r3.ok && r3.error.code, "STATE_CHANGED");

  // An edit to a claim file mid-read, too.
  once = true;
  const r4 = reconcile(
    repo,
    { base },
    flip(() => appendFileSync(join(repo, ".vcv/bindings/impl.cap-enroll.json"), " ")),
  );
  assert.equal(!r4.ok && r4.error.code, "STATE_CHANGED");
});

test("read-only, deterministic and redacted", () => {
  const { repo, base } = setup();
  edit(repo, SERVICE, DROP_REJECTION_NOTICE, "if (!reason) {\n      $1\n    }");
  const status = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
  const a = reconcile(repo, { base });
  const b = reconcile(repo, { base });
  assert.deepEqual(a, b);
  assert.equal(git(repo, "status", "--porcelain=v1", "--untracked-files=all"), status, "nothing was written");
  assert.ok(!JSON.stringify(a).includes(repo), "the checkout's absolute path never appears");
});

test("bad requests and unknown bases are refused clearly", () => {
  const { repo } = setup();
  const r1 = reconcile(repo, {});
  assert.equal(!r1.ok && r1.error.code, "INVALID_REQUEST");
  const r2 = reconcile(repo, { base: "no-such-branch" });
  assert.equal(!r2.ok && r2.error.code, "UNKNOWN_COMMIT");
  const r3 = reconcile(repo, { base: "main", extra: 1 });
  assert.equal(!r3.ok && r3.error.code, "INVALID_REQUEST");
  rmSync(join(repo, ".vcv"), { recursive: true });
  const r4 = reconcile(repo, { base: "main" });
  assert.equal(!r4.ok && r4.error.code, "PROJECT_NOT_READY");
});

// ---- review round 1 of PR #23 ---------------------------------------------------------------

const keys = mkdtempSync(join(tmpdir(), "vcv-keys-")); // outside every checkout

/** A genuinely attested introduced revision on the feature branch, with the trust list on main. */
function attested() {
  const repo = baseline();
  const keyFile = join(keys, `rev-${Math.random().toString(36).slice(2, 8)}.pem`);
  addTrustedReviewer(repo, createReviewerKey("user:hoang", keyFile));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "trust user:hoang");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "feature");
  const id = "chg-statement";
  const sub = submitProposal(
    repo,
    {
      changeId: id,
      projectId: "prj-course-desk",
      expectedRevision: projectStatus(repo).model!.revision,
      operations: [
        {
          type: "setRuleStatement",
          ruleId: "rul-seat-limit",
          statement: "A full course is rejected with COURSE_FULL and the capacity.",
        },
      ],
    },
    { principalId: "agent:coder", permissions: ["model:propose"] },
  );
  assert.ok(sub.ok);
  const pv = previewProposal(repo, { changeId: id });
  assert.ok(pv.ok);
  const trust = { kind: "git-ref" as const, ref: base, pinnedCommit: base };
  const r = reviewApprove(repo, { changeId: id, expectedDigest: pv.data.proposal.proposalDigest, keyFile, trust });
  assert.equal(r.outcome.status, "applied");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "approved");
  return { repo, base, trust, attestation: join(repo, ".vcv/approvals", `${id}.json`) };
}

test("P1: approval evidence read by integrity is rechecked, also when the attestation path is already dirty", () => {
  const { repo, base, trust, attestation } = attested();
  const strict = (hooks = {}) => reconcile(repo, { base, trust, requireAttestation: true }, hooks);
  const before = strict();
  assert.ok(before.ok);
  assert.equal(before.data.model.integrity.ok, true, JSON.stringify(before.data.model.integrity));
  assert.equal(before.data.model.introduced[0]!.approval, "attested");

  appendFileSync(attestation, "\n"); // harmless, but the path is now dirty: the changed-path set no longer moves
  assert.equal(
    strict().ok &&
      strict().ok &&
      (strict() as { data: { model: { integrity: { ok: boolean } } } }).data.model.integrity.ok,
    true,
  );
  let once = true;
  const raced = strict({
    afterRead: () => {
      if (!once) return;
      once = false;
      const a = JSON.parse(readFileSync(attestation, "utf8"));
      writeFileSync(attestation, `${JSON.stringify({ ...a, approverId: "user:mallory" }, null, 2)}\n`);
    },
  });
  assert.equal(
    !raced.ok && raced.error.code,
    "STATE_CHANGED",
    JSON.stringify(raced.ok ? raced.data.model.integrity : raced.error),
  );
  const after = strict();
  assert.ok(after.ok);
  assert.equal(after.data.model.integrity.ok, false, "the final bytes fail integrity, and a fresh call says so");
});

test("P1: a trust file or trust ref that moves mid-read is STATE_CHANGED", () => {
  const { repo, base, trust } = attested();
  // External trust file (outside the checkout).
  const file = join(mkdtempSync(join(tmpdir(), "vcv-trust-")), "reviewers.json");
  writeFileSync(file, `${git(repo, "show", `${base}:.vcv/reviewers.json`)}\n`);
  let once = true;
  const r1 = reconcile(
    repo,
    { base, trust: { kind: "file", path: file } },
    { afterRead: () => (once ? ((once = false), appendFileSync(file, " ")) : undefined) },
  );
  assert.equal(!r1.ok && r1.error.code, "STATE_CHANGED");
  // An unpinned trust ref that is moved.
  git(repo, "branch", "-q", "trusted", trust.pinnedCommit);
  once = true;
  const r2 = reconcile(
    repo,
    { base, trust: { kind: "git-ref", ref: "trusted" } },
    { afterRead: () => (once ? ((once = false), git(repo, "branch", "-qf", "trusted", "HEAD")) : undefined) },
  );
  assert.equal(!r2.ok && r2.error.code, "STATE_CHANGED");
});

test("P2: an unreadable claim store is reported as such, never as removed or unaffected claims", () => {
  for (const kind of ["file", "symlink"] as const) {
    const { repo, base } = setup();
    edit(repo, SERVICE, "Enrollment rules. Every decision", "Enrollment rules (x). Every decision");
    rmSync(join(repo, ".vcv/bindings"), { recursive: true });
    if (kind === "file") writeFileSync(join(repo, ".vcv/bindings"), "not a directory\n");
    else symlinkSync(mkdtempSync(join(tmpdir(), "vcv-elsewhere-")), join(repo, ".vcv/bindings"));
    const d = ok(repo, base);
    assert.equal(d.bindings.available, false, kind);
    assert.match(d.bindings.problem!, kind === "file" ? /not a directory/ : /symlink/);
    assert.deepEqual(
      [
        d.bindings.items.length,
        d.bindings.unaffected,
        d.summary.removedClaims,
        d.summary.bindingsAssessed,
        d.source.unmapped,
      ],
      [0, null, 0, false, null],
    );
    const f = finding(d, "CLAIM_STORE_UNREADABLE")!;
    assert.deepEqual([f.category, f.basis], ["binding", "not-checked"]);
    assert.ok(
      !codes(d).includes("CLAIM_REMOVED") &&
        !codes(d).includes("UNMAPPED_CHANGES") &&
        !codes(d).includes("OBJECT_UNBOUND"),
    );
    assert.equal(d.sourceImpact, null);
  }
});

test("P2: the serialized report stays within its byte budget for valid worst-case claims", () => {
  const { repo, base } = setup();
  const template = JSON.parse(readFileSync(join(repo, ".vcv/bindings/test.rul-seat-limit.json"), "utf8"));
  const long = `EnrollmentService > ${"x".repeat(50_000)}`;
  for (let i = 0; i < 5; i++)
    writeFileSync(
      join(repo, `.vcv/bindings/test.long-${i}.json`),
      JSON.stringify(
        {
          ...template,
          bindingId: `test.long-${i}`,
          locator: { ...template.locator, selector: { kind: "test", name: long } },
        },
        null,
        2,
      ),
    );
  const d = ok(repo, base);
  const bytes = Buffer.byteLength(JSON.stringify(d, null, 2));
  assert.ok(bytes <= RECONCILE_LIMITS.bytes, `${bytes} bytes`);
  assert.equal(d.budget.bytes, bytes);
  const row = d.bindings.items.find((b) => b.bindingId === "test.long-0")!;
  assert.ok(row.locator!.length <= RECONCILE_LIMITS.locatorChars);
  assert.match(row.locatorDigest!, /^[0-9a-f]{64}$/, "a cut locator keeps the digest of its full identity");
  for (const f of d.findings) assert.ok(f.message.length <= RECONCILE_LIMITS.textChars);

  // Many valid claims: lists are cut further, flagged, and the size still fits.
  for (let i = 0; i < 600; i++)
    writeFileSync(
      join(repo, `.vcv/bindings/test.many-${i}.json`),
      JSON.stringify(
        {
          ...template,
          bindingId: `test.many-${i}`,
          locator: { ...template.locator, selector: { kind: "test", name: `${long.slice(0, 2000)} ${i}` } },
        },
        null,
        2,
      ),
    );
  const m = ok(repo, base);
  const mBytes = Buffer.byteLength(JSON.stringify(m, null, 2));
  assert.ok(mBytes <= RECONCILE_LIMITS.bytes, `${mBytes} bytes`);
  assert.equal(m.budget.shrunk, true);
  assert.ok(m.bindings.truncated && m.bindings.total > m.bindings.items.length);
  assert.ok(m.findingsTruncated && m.findingsTotal > m.findings.length);
});
