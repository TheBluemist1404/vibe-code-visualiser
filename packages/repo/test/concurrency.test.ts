// Writer serialization at the repository surface (Issue #43): separate processes running the
// trusted reviewer approval and the proposal-only submission against one checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@vcv/testkit";
import { LOCK_FILE, proposalDigest } from "../../core/src/index.ts";
import type { HostContext, ProposedModelChange } from "../../core/src/index.ts";
import {
  addTrustedReviewer,
  checkIntegrity,
  createReviewerKey,
  projectStatus,
  reviewFinalize,
  submitProposal,
} from "../src/index.ts";
import type { TrustSource } from "../src/index.ts";
import { baseline, git } from "./course-desk.ts";

const WORKER = join(import.meta.dirname, "workers", "repo-writer.ts");
const agent: HostContext = { principalId: "agent:coder", permissions: ["model:propose"] };
const keys = tempDir("vcv-keys-");

function setup() {
  const repo = baseline();
  const reviewers = ["user:hoang", "user:lin"].map((id) => {
    const file = join(keys, `${id.replace(/\W/g, "_")}-${Math.random().toString(36).slice(2, 8)}.pem`);
    addTrustedReviewer(repo, createReviewerKey(id, file));
    return { id, file };
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "trust reviewers");
  git(repo, "checkout", "-q", "-b", "feature");
  return { repo, reviewers };
}
const trust = (repo: string): TrustSource => ({
  kind: "git-ref",
  ref: "main",
  pinnedCommit: git(repo, "rev-parse", "main"),
});
const rev = (repo: string) => projectStatus(repo).model!.revision;
const change = (repo: string, id: string): ProposedModelChange => ({
  changeId: id,
  projectId: "prj-course-desk",
  expectedRevision: rev(repo),
  rationale: `test ${id}`,
  operations: [{ type: "setDescription", objectId: "mod-web", description: `edited by ${id}` }],
});
function propose(repo: string, c: ProposedModelChange) {
  const r = submitProposal(repo, c, agent);
  assert.equal(r.ok && r.data.status, "pending", JSON.stringify(r));
  return proposalDigest(c);
}

type Line = Record<string, unknown>;
function run(task: Record<string, unknown>) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", WORKER, JSON.stringify(task)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines: Line[] = [];
  let buf = "";
  let ready!: () => void;
  const readyP = new Promise<void>((r) => {
    ready = r;
  });
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const l = JSON.parse(buf.slice(0, i)) as Line;
      buf = buf.slice(i + 1);
      lines.push(l);
      if (l.ready) ready();
    }
  });
  const done = new Promise<{ code: number | null; last: Line }>((resolve) =>
    child.on("close", (code) => {
      ready();
      resolve({ code, last: lines.at(-1)! });
    }),
  );
  return { ready: readyP, done };
}
async function race(tasks: Record<string, unknown>[]) {
  const barrier = join(tempDir("vcv-barrier-"), "go");
  const ws = tasks.map((t) => run({ ...t, barrier }));
  await Promise.all(ws.map((w) => w.ready));
  writeFileSync(barrier, "");
  return (await Promise.all(ws.map((w) => w.done))).map((r) => r.last);
}

test("approve vs approve across processes: one reviewer's approval applies and is attested; the other gets NOT_PENDING; the one attestation signs the reviewed digest", async () => {
  const { repo, reviewers } = setup();
  const digest = propose(repo, change(repo, "chg-a"));
  const out = await race(
    reviewers.map((r) => ({
      repo,
      action: "approve",
      approve: { changeId: "chg-a", expectedDigest: digest, keyFile: r.file, trust: trust(repo) },
    })),
  );
  const won = out.filter((o) => o.status === "applied");
  assert.equal(won.length, 1, JSON.stringify(out));
  assert.deepEqual(out.find((o) => o.status !== "applied")!.codes, ["NOT_PENDING"]);
  assert.deepEqual(readdirSync(join(repo, ".vcv/approvals")), ["chg-a.json"]);
  const att = JSON.parse(readFileSync(join(repo, ".vcv/approvals/chg-a.json"), "utf8"));
  const rec = JSON.parse(readFileSync(join(repo, ".vcv/changes/chg-a.json"), "utf8"));
  assert.equal(att.proposalDigest, digest);
  assert.equal(att.approverId, rec.approverId, "attested by the approver the record names");
  assert.equal(att.resultingRevision, rev(repo));
  assert.equal(
    checkIntegrity(repo, { base: "main", trust: { kind: "git-ref", ref: "main" }, requireAttestation: true }).ok,
    true,
  );
});

test("approve vs submit across processes: the approval lands; the concurrent submission is recorded (pending, or stale if decided after the approval); the proposal-only surface never sees HEAD move under it", async () => {
  for (let round = 0; round < 3; round++) {
    const { repo, reviewers } = setup();
    const digest = propose(repo, change(repo, "chg-a"));
    const [ap, sub] = await race([
      {
        repo,
        action: "approve",
        approve: { changeId: "chg-a", expectedDigest: digest, keyFile: reviewers[0]!.file, trust: trust(repo) },
      },
      { repo, action: "submit", change: change(repo, "chg-b"), host: agent },
    ]);
    assert.equal(ap!.status, "applied", JSON.stringify(ap));
    // Serialized either way: submitted first (pending), or decided on the approved revision (a
    // deterministic STALE_REVISION, recorded as rejected). Never an exception, never lost.
    if (sub!.status !== "pending")
      assert.deepEqual([sub!.status, sub!.codes], ["rejected", ["STALE_REVISION"]], JSON.stringify(sub));
    const recs = readdirSync(join(repo, ".vcv/changes")).sort();
    assert.deepEqual(recs, ["chg-a.json", "chg-b.json"]);
    assert.equal((ap!.attestation as { proposalDigest: string }).proposalDigest, digest);
  }
});

test("a reviewer process dying after the commit, before the attestation: the next writer breaks its lock; finalize writes the attestation for the reviewed digest", async () => {
  const { repo, reviewers } = setup();
  const digest = propose(repo, change(repo, "chg-a"));
  const approve = { changeId: "chg-a", expectedDigest: digest, keyFile: reviewers[0]!.file, trust: trust(repo) };
  const crashed = await run({ repo, action: "approve", approve, crashAfterCommit: true }).done;
  assert.equal(crashed.code, 137);
  assert.ok(existsSync(join(repo, ".vcv", LOCK_FILE)), "the dead process's lock is left behind");
  assert.ok(!existsSync(join(repo, ".vcv/approvals/chg-a.json")));
  const fin = reviewFinalize(repo, approve);
  assert.equal(fin.attestation!.attestation.proposalDigest, digest);
  assert.ok(!existsSync(join(repo, ".vcv", LOCK_FILE)));
  assert.equal(
    checkIntegrity(repo, { base: "main", trust: { kind: "git-ref", ref: "main" }, requireAttestation: true }).ok,
    true,
  );
});

test("the writer lock never shows in Git: cache/ is ignored by .vcv/.gitignore", () => {
  const { repo } = setup();
  propose(repo, change(repo, "chg-a"));
  assert.ok(existsSync(join(repo, ".vcv/cache")), "the lock directory was created");
  const status = git(repo, "status", "--porcelain", "--ignored=no", ".vcv");
  assert.ok(!/cache/.test(status), status);
});
