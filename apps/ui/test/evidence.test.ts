// The evidence explorer over HTTP (M5.5, Issue #45), on a real Course Desk checkout: every answer
// is what @vcv/repo's own evidence, criteria, handoff, implementation, reconciliation and gate
// functions say about the checkout now. Nothing is written, reasserted, run or decided here, and
// the pre-merge views need a base commit the person starting the host names explicitly.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { preMergeGate, projectStatus } from "@vcv/repo";
import { EvidenceDesk } from "../src/evidence.ts";
import type { EvidenceOptions } from "../src/evidence.ts";
import { LayoutFileStore } from "../src/layout-store.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProjectSession, modelKey } from "../src/session.ts";
import type {
  GateView,
  ImplementationView,
  ModuleEvidenceView,
  ObjectEvidenceView,
  ProjectView,
} from "../src/types.ts";
import { SERVICE } from "../../../packages/repo/test/course-desk.ts";
import { FAIL, claimedRun, evidenceWorld } from "./evidence-fixture.ts";
import { git, renameModule, tempDir, tree } from "./fixtures.ts";

const hosts: Host[] = [];
after(() => Promise.all(hosts.map((h) => h.close())));

async function open(repo: string, evidence?: EvidenceOptions) {
  const host = await startHost({
    session: new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-"))),
    webDir: tempDir(),
    ...(evidence ? { evidence } : {}),
  });
  hosts.push(host);
  return async <T>(path: string, init?: RequestInit) => {
    const r = await fetch(host.url + path.replace(/^\//, ""), init);
    return { status: r.status, body: (await r.json()) as T & { error?: { code: string; message: string } } };
  };
}

// One world for the read-only tests (building it takes a few seconds); tests that move the
// checkout build their own.
let w: ReturnType<typeof evidenceWorld>;
before(() => {
  w = evidenceWorld();
});

test("object evidence: each claim's state, locator, provenance and both freshness causes, as the repo reports them; nothing written", async () => {
  const snapshot = tree(w.repo);
  const get = await open(w.repo);
  const r = await get<ObjectEvidenceView>("/api/evidence/objects/rul-seat-limit");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = r.body;
  assert.equal(o.object.id, "rul-seat-limit");
  assert.equal(o.counts.total, 2);
  assert.equal(o.counts.resolved, 1);
  assert.equal(o.counts.stale, 1);
  const by = new Map(o.bindings.map((b) => [b.bindingId, b]));
  const impl = by.get("impl.rul-seat-limit")!;
  assert.equal(impl.state, "resolved");
  assert.equal(impl.relation, "implements");
  assert.match(impl.locator!, /enrollment\.service\.ts/);
  assert.equal(impl.provenance?.principalId, "agent:coder");
  assert.equal(impl.pointer?.state, "resolved");
  const test = by.get("test.rul-seat-limit")!;
  assert.equal(test.state, "stale");
  assert.equal(test.modelFreshness?.state, "changed");
  assert.match(test.modelFreshness!.cause, /rul-seat-limit changed between rev-1/);
  assert.equal(o.criterion, null);
  assert.ok(o.limits.some((l) => /not evidence that the code does what the model says/.test(l)));
  assert.equal(o.observed.modelRevision, projectStatus(w.repo).model!.revision);
  assert.equal(o.observed.branch, "feature");
  assert.deepEqual(tree(w.repo), snapshot, "reading evidence changes nothing in the checkout");
});

test("a criterion: its test mapping resolves, but with no runs given its result is unverified; a run the agent captured is labelled claimed", async () => {
  const bare = await open(w.repo);
  const c = (await bare<ObjectEvidenceView>("/api/evidence/objects/crt-full-course")).body.criterion!;
  assert.equal(c.verification, "required");
  assert.equal(c.mapping, "resolved");
  assert.equal(c.result, "unverified");
  assert.equal(c.runsSupplied, 0);
  assert.match(c.mappings[0]!.test!, /rejects an enrollment into a full course/);

  const withRun = await open(w.repo, {
    runs: [claimedRun(w.repo)],
    sources: { runs: ["agent-run.json"], policy: null },
  });
  const cr = (await withRun<ObjectEvidenceView>("/api/evidence/objects/crt-full-course")).body.criterion!;
  assert.equal(cr.result, "passed");
  assert.equal(cr.resultObservedBy, "claimed", "a run handed to the host is a claim, never host evidence");
  assert.deepEqual(cr.mappings[0]!.result?.observedBy, ["claimed"]);
  assert.ok(cr.problems.some((p) => p.code === "RESULT_CLAIMED"));
});

test("module evidence: claims per owned object, by state", async () => {
  const get = await open(w.repo);
  const m = (await get<ModuleEvidenceView>("/api/evidence/modules/mod-enrollment")).body;
  const by = new Map(m.objects.map((o) => [o.id, o]));
  assert.equal(by.get("mod-enrollment")!.kind, "module");
  assert.deepEqual(by.get("rul-seat-limit")!.states, { resolved: 1, stale: 1 });
  assert.equal(by.get("cap-enroll")!.claims, 2);
  assert.equal(by.get("crt-full-course")!.claims, 1);
  assert.equal(m.truncated, false);
  assert.equal((await get("/api/evidence/modules/mod-nowhere")).status, 404);
  assert.equal((await get("/api/evidence/objects/BAD%20ID")).status, 400);
});

test("an approved change's implementation: the handoff, the agent's report as claims, and what VCV observes now, kept apart", async () => {
  const get = await open(w.repo);
  const r = await get<ImplementationView>(`/api/proposals/${w.changeId}/implementation`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = r.body;
  assert.equal(v.handoff?.approvedRevision, w.approvedRevision);
  assert.equal(
    v.handoff?.request?.behavior,
    "When a course is full, the rejection tells the student the course's capacity.",
  );
  assert.ok(v.handoff!.bindings.some((b) => b.bindingId === "impl.rul-seat-limit"));
  const rep = v.report!;
  assert.equal(rep.claims.by, "agent:coder");
  assert.match(rep.claims.note, /verified none of it/);
  assert.deepEqual(rep.claims.gaps, ["the web page does not show the capacity yet"]);
  assert.ok(rep.observedNow.filesModified.includes("server/src/enrollment/enrollment.service.ts"));
  const codes = rep.warnings.map((x) => x.code);
  for (const c of ["CLAIMS_UNVERIFIED", "GAP", "CRITERION_UNADDRESSED", "BINDING_NOT_REASSERTED"])
    assert.ok(codes.includes(c), `${c} in ${codes}`);
  assert.match(rep.notReconciled, /reconcil/i);

  // A change that is not applied here has no handoff, and says why.
  const none = (await get<ImplementationView>("/api/proposals/chg-criteria-nope/implementation")).body;
  assert.equal(none.handoff, null);
  assert.ok(none.handoffProblem);
});

test("the gate needs an explicit base commit: without one it names what is missing and runs nothing; with one it is preMergeGate's own decision", async () => {
  const plain = await open(w.repo);
  const g0 = (await plain<GateView>("/api/gate")).body;
  assert.equal(g0.gate, null);
  assert.equal(g0.reconciliation, null);
  assert.deepEqual(g0.inputs.missing.length, 1);
  assert.match(g0.inputs.missing[0]!, /--base-commit/);

  const runs = [claimedRun(w.repo, FAIL)];
  const get = await open(w.repo, { baseCommit: w.base, runs, sources: { runs: ["agent-run.json"], policy: null } });
  const g = (await get<GateView>("/api/gate")).body;
  assert.equal(g.problem, null);
  const direct = preMergeGate(w.repo, { base: w.base, runs }, { principalId: "vcv-ui", permissions: [] });
  assert.ok(direct.ok);
  assert.equal(g.gate!.decision, direct.data.decision);
  assert.equal(g.gate!.headline, direct.data.headline);
  assert.deepEqual(
    g.gate!.reasons.map((r) => r.code),
    direct.data.reasons.map((r) => r.code),
  );
  assert.equal(g.gate!.decision, "block");
  assert.ok(g.gate!.runs.every((r) => r.observedBy === "claimed"));
  assert.equal(g.reconciliation!.base.commit, w.base);
  assert.equal(g.reconciliation!.lineage, "extends");
  assert.equal(g.reconciliation!.integrity.ok, true);
  assert.match(g.reconciliation!.integrity.authorization, /caller-asserted/);
  assert.deepEqual(g.inputs, { baseCommit: w.base, runs: ["agent-run.json"], policy: null, missing: [] });
});

test("evidence is read-only: writes are refused and there is no reassert, run or record route", async () => {
  const snapshot = tree(w.repo);
  const get = await open(w.repo, { baseCommit: w.base });
  for (const path of ["/api/evidence/objects/rul-seat-limit", "/api/evidence/modules/mod-enrollment", "/api/gate"]) {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const r = await get(path, { method, headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(r.status, 405, `${method} ${path}`);
      assert.equal(r.body.error?.code, "READ_ONLY");
    }
  }
  for (const path of ["/api/evidence/objects/rul-seat-limit/reassert", "/api/evidence/runs", "/api/gate/run"])
    assert.equal((await get(path)).status, 404, path);
  const impl = await get(`/api/proposals/${w.changeId}/implementation`, { method: "POST", body: "{}" });
  assert.equal(impl.status, 405);
  assert.deepEqual(tree(w.repo), snapshot);
});

test("an answer about a model the page no longer shows is STATE_CHANGED, not silently about the new one", async () => {
  const { repo } = evidenceWorld();
  const get = await open(repo);
  const shown = (await get<ProjectView>("/api/project")).body.graph!.modelKey;
  const q = `?model=${encodeURIComponent(shown)}`;
  assert.equal((await get(`/api/evidence/objects/rul-seat-limit${q}`)).status, 200);
  // Someone applies another change in their terminal while the page is open.
  renameModule(repo, "chg-rename", "mod-enrollment", "Enrollment (renamed)");
  for (const path of [
    `/api/evidence/objects/rul-seat-limit${q}`,
    `/api/evidence/modules/mod-enrollment${q}`,
    `/api/gate${q}`,
    `/api/proposals/chg-capacity/implementation${q}`,
  ]) {
    const r = await get(path);
    assert.equal(r.status, 409, path);
    assert.equal(r.body.error?.code, "STATE_CHANGED");
  }
  // Without a model key, the answer is about the checkout as it is now.
  const now = (await get<ObjectEvidenceView>("/api/evidence/objects/rul-seat-limit")).body;
  assert.equal(now.observed.modelRevision, projectStatus(repo).model!.revision);
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
});

test("one gate answer is one state: a model change landing between reconciliation and the gate is never stitched in; a checkout that keeps moving is STATE_CHANGED", () => {
  const { repo, base } = evidenceWorld();
  const session = new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-")));
  let once = true;
  const desk = new EvidenceDesk(session, {
    baseCommit: base,
    betweenReads: (step) => {
      if (step !== "after-reconcile" || !once) return;
      once = false;
      renameModule(repo, "chg-mid", "mod-web", "Web (mid-read)");
    },
  });
  const g = desk.gate();
  assert.equal(once, false, "the change did land mid-read");
  const now = projectStatus(repo).model!.revision;
  assert.equal(g.reconciliation!.candidate.modelRevision, now, "reconciliation is of the final state");
  assert.equal(g.modelKey, modelKey(projectStatus(repo)));

  let n = 0;
  const restless = new EvidenceDesk(session, {
    betweenReads: (step) => {
      if (step === "after-handoff") renameModule(repo, `chg-noise-${n++}`, "mod-web", `Web ${n}`);
    },
  });
  assert.throws(
    () => restless.implementation("chg-capacity"),
    (e: { code?: string }) => e.code === "STATE_CHANGED",
  );
  assert.ok(n >= 2, "it retried before giving up");
});

test("source edits are part of the observed state: a dirty→dirty edit between reads is never stitched in; edits on every read are STATE_CHANGED; an unbounded working tree is refused, not guessed", async () => {
  const { repo, base, changeId } = evidenceWorld();
  const file = join(repo, SERVICE);
  const original = readFileSync(file, "utf8");
  writeFileSync(file, `${original}\n// dirty version A\n`); // already dirty before any read
  const session = new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-")));
  const editTo = (tag: string) => writeFileSync(file, `${original}\n// dirty version ${tag}\n`);

  for (const [step, read] of [
    ["after-reconcile", (d: EvidenceDesk) => d.gate()],
    ["after-handoff", (d: EvidenceDesk) => d.implementation(changeId)],
    ["after-evidence", (d: EvidenceDesk) => d.object("rul-seat-limit")],
  ] as const) {
    // One edit (A → B) lands mid-read: the first composition is discarded and the answer is of B.
    let calls = 0;
    const once = new EvidenceDesk(session, {
      baseCommit: base,
      betweenReads: (s) => {
        if (s !== step) return;
        if (calls++ === 0) editTo(`B-${step}`);
      },
    });
    read(once);
    assert.equal(calls, 2, `${step}: the read was retried after the mid-read edit`);

    // An edit on every read: refused.
    let n = 0;
    const restless = new EvidenceDesk(session, {
      baseCommit: base,
      betweenReads: (s) => {
        if (s === step) editTo(`C-${step}-${n++}`);
      },
    });
    assert.throws(
      () => read(restless),
      (e: { code?: string }) => e.code === "STATE_CHANGED",
      step,
    );
  }

  // Too many untracked files to fingerprint: OBSERVATION_LIMIT (422), never a silent answer.
  const junk = join(repo, "scratch");
  mkdirSync(junk);
  for (let i = 0; i < 2001; i++) writeFileSync(join(junk, `f${i}.txt`), String(i));
  const get = await open(repo, { baseCommit: base });
  const r = await get("/api/gate");
  assert.equal(r.status, 422);
  assert.equal(r.body.error?.code, "OBSERVATION_LIMIT");
});
