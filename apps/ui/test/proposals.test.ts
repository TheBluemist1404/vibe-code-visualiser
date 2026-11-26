// The proposal inbox over HTTP (M5.4, Issue #44), on real checkouts with the real CLI: an agent
// submits, the UI shows what `vcv proposal preview` shows, a reviewer approves in their own
// terminal with a test-only key, and the UI reports the signed result without ever claiming more
// than the checks it ran. The host has no write route for proposals.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { projectStatus } from "@vcv/repo";
import { LayoutFileStore } from "../src/layout-store.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProposalInbox } from "../src/proposals.ts";
import { ProjectSession, modelKey } from "../src/session.ts";
import type { Inbox, ProposalReview, ReviewStep } from "../src/types.ts";
import { approve, cliPreview, clean, describeWeb, git, setup, submit, tempDir, tree, vcv } from "./fixtures.ts";

const hosts: Host[] = [];
after(() => Promise.all(hosts.map((h) => h.close())));

async function open(repo: string, protectedBase?: string) {
  const host = await startHost({
    session: new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-"))),
    webDir: tempDir(),
    ...(protectedBase ? { protectedBase } : {}),
  });
  hosts.push(host);
  const call = async <T>(path: string, init?: RequestInit) => {
    const r = await fetch(host.url + path.replace(/^\//, ""), init);
    return { status: r.status, body: (await r.json()) as T & { error?: { code: string; message: string } } };
  };
  return {
    call,
    inbox: async () => (await call<Inbox>("/api/proposals")).body,
    review: async (id: string) => (await call<ProposalReview>(`/api/proposals/${id}`)).body,
  };
}
const step = (r: ProposalReview, id: ReviewStep["id"]) => r.steps.find((s) => s.id === id)!;

test("an agent's CLI proposal shows up as pending with the same digest and operations as `vcv proposal preview`; the reviewer gets a command for that exact digest, not a button", async () => {
  const { repo } = setup();
  assert.equal(submit(repo, "chg-web", describeWeb("Pages for students and staff.")).status, 0);
  const before = tree(repo);
  const ui = await open(repo);
  const inbox = await ui.inbox();
  assert.deepEqual(
    inbox.items.map((i) => [i.changeId, i.lifecycle, i.proposerId]),
    [["chg-web", "pending", "agent:coder"]],
  );
  assert.equal(inbox.counts.pending, 1);
  assert.equal(inbox.protectedBase, null);

  const r = await ui.review("chg-web");
  const cli = cliPreview(repo, "chg-web");
  assert.equal(r.proposalDigest, cli.proposal.proposalDigest);
  assert.deepEqual(
    r.check.operations.map((o) => o.summary),
    cli.proposal.operations.map((o) => o.summary),
  );
  assert.equal(r.lifecycle, "pending");
  assert.deepEqual(
    r.steps.map((s) => [s.id, s.state]),
    [
      ["recorded", "done"],
      ["signed", "not-yet"],
      ["integrity", "not-yet"],
      ["model", "not-yet"],
      ["implementation", "unknown"],
    ],
  );
  assert.ok(r.check.delta?.changes.some((c) => c.id === "mod-web"));
  assert.equal(r.reviewer?.digest, cli.proposal.proposalDigest);
  const approveCmd = r.reviewer!.commands.find((c) => c.text.includes("review approve"))!.text;
  assert.match(approveCmd, new RegExp(`--digest ${cli.proposal.proposalDigest}`));
  assert.match(approveCmd, /--key <your reviewer key file>/, "no key path is filled in or known here");
  assert.equal(r.agent, null);
  assert.equal(r.implementation, undefined, "no request was proposed");
  assert.equal(projectStatus(repo).model!.revision, "rev-1");
  assert.deepEqual(tree(repo), before, "reading the inbox changes nothing in the checkout");
});

test("a pending proposal shows the implementation request the digest covers", async () => {
  const { repo } = setup();
  const implementation = {
    behavior: "The web module describes pages for students and staff.",
    acceptanceCriteria: ["The landing page names both audiences"],
    scope: ["web/**"],
  };
  const s = submit(repo, "chg-web", describeWeb("Pages for students and staff."), undefined, { implementation });
  assert.equal(s.status, 0, s.stderr);
  const r = await (await open(repo)).review("chg-web");
  assert.equal(r.lifecycle, "pending");
  assert.deepEqual(r.implementation, implementation);
  assert.equal(r.proposalDigest, cliPreview(repo, "chg-web").proposal.proposalDigest);
});

test("there is no write route: POST/PUT/DELETE on proposals is refused, and approve is not a route", async () => {
  const { repo } = setup();
  submit(repo, "chg-web", describeWeb("x"));
  const ui = await open(repo);
  const before = tree(repo);
  for (const path of ["/api/proposals", "/api/proposals/chg-web", "/api/proposals/chg-web/approve"]) {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const r = await ui.call(path, { method, headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(r.status, 405, `${method} ${path}`);
      assert.equal(r.body.error?.code, "READ_ONLY");
    }
  }
  assert.equal((await ui.call("/api/proposals/chg-web/approve")).status, 404);
  assert.equal((await ui.call("/api/approve")).status, 404);
  assert.equal((await ui.call("/api/proposals/no-such")).status, 404);
  assert.equal((await ui.call("/api/proposals/BAD%20ID")).status, 400);
  assert.deepEqual(tree(repo), before);
  assert.equal((await ui.review("chg-web")).lifecycle, "pending");
});

test("stale and rejected proposals show the engine's own errors and an agent handoff; nothing offers a rebase or an approval", async () => {
  const { repo, key, mainSha } = setup();
  submit(repo, "chg-a", describeWeb("first"));
  submit(repo, "chg-b", describeWeb("second"));
  assert.equal(
    submit(repo, "chg-bad", [{ type: "setDescription", objectId: "mod-nowhere", description: "x" }]).status,
    1,
  );
  const ui = await open(repo);
  // A reviewer applies chg-a; chg-b is now based on an earlier revision.
  const digest = cliPreview(repo, "chg-a").proposal.proposalDigest;
  const ok = approve(repo, "chg-a", digest, key, "--trust-ref", "main", "--trust-commit", mainSha);
  assert.equal(ok.status, 0, ok.stderr);

  const inbox = await ui.inbox();
  const by = new Map(inbox.items.map((i) => [i.changeId, i]));
  assert.equal(by.get("chg-a")!.lifecycle, "applied");
  assert.equal(by.get("chg-b")!.lifecycle, "stale");
  assert.equal(by.get("chg-bad")!.lifecycle, "rejected");

  const stale = await ui.review("chg-b");
  assert.equal(stale.reviewer, null, "a stale proposal gets no approval instructions");
  assert.match(stale.agent!.note, /Nothing here rebases it/);
  assert.equal(stale.check.validation.appliesToCurrent, false);
  assert.ok(stale.check.validation.errors.some((e) => e.code === "STALE_REVISION"));

  const bad = await ui.review("chg-bad");
  assert.equal(bad.reviewer, null);
  assert.match(bad.agent!.note, /final/);
  assert.ok(bad.atSubmission.some((d) => d.code === "UNKNOWN_OBJECT" || d.severity === "error"));
  assert.equal(step(bad, "model").state, "not-yet");
});

test("after a reviewer approves with the CLI, the UI shows the applied revision and a verifying signature; integrity stays unknown without a protected base, and is checked (caller-asserted) with one", async () => {
  const { repo, key, mainSha } = setup();
  submit(repo, "chg-web", describeWeb("Approved description."));
  const digest = cliPreview(repo, "chg-web").proposal.proposalDigest;
  // A wrong digest (content changed after review) is refused by the CLI; the UI still says pending.
  const wrong = approve(repo, "chg-web", "0".repeat(64), key, "--trust-ref", "main", "--trust-commit", mainSha);
  assert.notEqual(wrong.status, 0);
  const plain = await open(repo);
  assert.equal((await plain.review("chg-web")).lifecycle, "pending");

  const ok = approve(repo, "chg-web", digest, key, "--trust-ref", "main", "--trust-commit", mainSha);
  assert.equal(ok.status, 0, ok.stderr);
  const r = await plain.review("chg-web");
  assert.equal(r.lifecycle, "applied");
  assert.equal(r.resultingRevision, projectStatus(repo).model!.revision);
  assert.equal(r.recordedApproverId, "user:reviewer");
  assert.equal(step(r, "signed").state, "done");
  assert.match(step(r, "signed").detail, /not checked here/);
  assert.equal(step(r, "integrity").state, "unknown");
  assert.match(step(r, "integrity").detail, /--protected-base/);
  assert.equal(step(r, "model").state, "done");
  assert.equal(step(r, "implementation").state, "unknown");
  assert.equal(r.reviewer, null);

  const based = await open(repo, "main");
  assert.equal((await based.inbox()).protectedBase, "main");
  const rb = await based.review("chg-web");
  assert.equal(step(rb, "integrity").state, "done", step(rb, "integrity").detail);
  assert.match(step(rb, "integrity").detail, /caller-asserted/);
  assert.ok(rb.integrityLimits.length > 0);
});

test("an untrusted key never shows as verified: signed with a key the protected base does not list, integrity fails", async () => {
  const { repo } = setup();
  submit(repo, "chg-web", describeWeb("Signed by a stranger."));
  const digest = cliPreview(repo, "chg-web").proposal.proposalDigest;
  // A key added only in the working tree (the unsafe development mode trusts it locally).
  const stranger = join(tempDir("vcv-ui-keys-"), "stranger.pem");
  assert.equal(vcv(clean(), "reviewer", "init", stranger, "--id", "user:stranger", "--add", repo).status, 0);
  const ok = approve(repo, "chg-web", digest, stranger, "--trust-working-tree");
  assert.equal(ok.status, 0, ok.stderr);
  const ui = await open(repo, "main");
  const r = await ui.review("chg-web");
  assert.equal(r.lifecycle, "applied");
  assert.equal(step(r, "signed").state, "done", "the signature itself verifies");
  assert.equal(step(r, "integrity").state, "failed");
  assert.match(step(r, "integrity").detail, /untrusted-key|not listed/);
});

test("one review is one state: an approval landing between the reads is never stitched in; a checkout that keeps moving is STATE_CHANGED", async () => {
  const { repo, key, mainSha } = setup();
  submit(repo, "chg-web", describeWeb("Approved mid-read."));
  const digest = cliPreview(repo, "chg-web").proposal.proposalDigest;
  const session = new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-")));

  // The reviewer approves in their terminal after the preview was read and before the list and
  // integrity reads. The first composition is discarded; the answer is entirely the applied state.
  let once = true;
  const inbox = new ProposalInbox(session, {
    protectedBase: "main",
    betweenReads: (step) => {
      if (step !== "after-preview" || !once) return;
      once = false;
      const r = approve(repo, "chg-web", digest, key, "--trust-ref", "main", "--trust-commit", mainSha);
      assert.equal(r.status, 0, r.stderr);
    },
  });
  const r = inbox.review("chg-web");
  assert.equal(once, false, "the approval did land mid-read");
  assert.equal(r.lifecycle, "applied");
  assert.equal(r.currentRevision, projectStatus(repo).model!.revision);
  assert.equal(r.modelKey, modelKey(projectStatus(repo)));
  assert.equal(step(r, "signed").state, "done");
  assert.equal(step(r, "model").state, "done");
  assert.equal(r.reviewer, null, "no approval instructions for an applied change");

  // Records that change on every read (another process submitting again and again) are refused.
  let n = 0;
  const restless = new ProposalInbox(session, {
    betweenReads: (step) => {
      if (step === "after-preview") submit(repo, `chg-noise-${n++}`, describeWeb(`noise ${n}`));
    },
  });
  assert.throws(
    () => restless.review("chg-web"),
    (e: { code?: string }) => e.code === "STATE_CHANGED",
  );
  assert.ok(n >= 2, "it retried before giving up");

  // A branch switch between reads: same rule.
  git(repo, "checkout", "-qb", "elsewhere", "main");
  git(repo, "checkout", "-q", "feature");
  let flips = 0;
  const switching = new ProposalInbox(session, {
    betweenReads: (step) => {
      if (step === "after-preview") git(repo, "checkout", "-q", flips++ % 2 ? "feature" : "elsewhere");
    },
  });
  assert.throws(
    () => switching.review("chg-web"),
    (e: { code?: string }) => e.code === "STATE_CHANGED",
  );
  git(repo, "checkout", "-q", "feature");

  // Over HTTP the refusal is a 409 the page retries on its next poll.
  const ui = await open(repo, "main");
  const ok = await ui.review("chg-web");
  assert.equal(ok.lifecycle, "applied");
  assert.equal(step(ok, "integrity").label, "Integrity, checked locally (caller-asserted base)");
});

test("'Model applied' needs positive history evidence from the record's own summary: an applied record past the first list page, a resulting revision this checkout lacks, and a record that names none", async () => {
  const { repo, key, mainSha } = setup();
  submit(repo, "chg-web", describeWeb("Applied, then buried under other records."));
  const digest = cliPreview(repo, "chg-web").proposal.proposalDigest;
  const changes = join(repo, ".vcv", "changes");
  const pending = JSON.parse(readFileSync(join(changes, "chg-web.json"), "utf8")) as {
    changeId: string;
    change: { changeId: string };
  };
  assert.equal(approve(repo, "chg-web", digest, key, "--trust-ref", "main", "--trust-commit", mainSha).status, 0);
  // 201 well-formed (now stale) records that sort first fill the inbox's first page (200).
  for (let i = 0; i <= 200; i++) {
    const id = `aaa-${String(i).padStart(3, "0")}`;
    pending.changeId = id;
    pending.change.changeId = id;
    writeFileSync(join(changes, `${id}.json`), JSON.stringify(pending));
  }
  const ui = await open(repo);
  const inbox = await ui.inbox();
  assert.equal(inbox.truncated, true);
  assert.ok(!inbox.items.some((i) => i.changeId === "chg-web"), "the applied record is outside the first page");
  const r = await ui.review("chg-web");
  assert.equal(r.lifecycle, "applied");
  assert.equal(step(r, "model").state, "done");
  assert.equal(r.resultingRevision, projectStatus(repo).model!.revision);

  // The record claims a revision this checkout's history does not contain.
  const file = join(changes, "chg-web.json");
  const record = JSON.parse(readFileSync(file, "utf8")) as { resultingRevision?: string };
  const real = record.resultingRevision!;
  record.resultingRevision = `${real.slice(0, -1)}${real.endsWith("0") ? "1" : "0"}`;
  writeFileSync(file, JSON.stringify(record));
  const other = await ui.review("chg-web");
  assert.equal(step(other, "model").state, "unknown");
  assert.match(step(other, "model").detail, /does not contain it/);

  // The record names no resulting revision at all: never shown as done.
  delete record.resultingRevision;
  writeFileSync(file, JSON.stringify(record));
  const none = await ui.call<ProposalReview>("/api/proposals/chg-web");
  if (none.status === 200) assert.notEqual(step(none.body, "model").state, "done");
  else assert.ok([409, 422].includes(none.status), JSON.stringify(none.body));
});
