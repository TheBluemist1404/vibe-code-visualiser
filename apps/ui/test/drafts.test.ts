// Local human drafts over HTTP, on real checkouts: staging typed operations, the engine's dry
// run, the agent handoff that the existing CLI accepts, staleness without retargeting, recovery
// after a restart, isolation between checkouts, two-tab conflicts, and unreadable draft files.
// The checkout (its files, .vcv/ and Git) must stay byte-identical throughout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { proposedChangeSchema } from "@vcv/core";
import { previewProposal, projectStatus } from "@vcv/repo";
import { DRAFT_LIMITS } from "../src/drafts/format.ts";
import { DraftFileStore } from "../src/drafts/store.ts";
import { LayoutFileStore } from "../src/layout-store.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProjectSession } from "../src/session.ts";
import type { DraftExport, DraftList, DraftPreview, DraftView, ModuleView, ObjectView } from "../src/types.ts";
import { addAuditModule, courseDesk, git, orphanBranchWithOtherModel, tempDir, tree } from "./fixtures.ts";

const CLI = join(import.meta.dirname, "../../cli/src/main.ts");
const hosts: Host[] = [];
after(() => Promise.all(hosts.map((h) => h.close())));

type Err = { error?: { code: string; message: string }; current?: { version: number } };

async function open(repo: string, stateDir = tempDir("vcv-ui-state-")) {
  const host = await startHost({ session: new ProjectSession(repo, new LayoutFileStore(stateDir)), webDir: tempDir() });
  hosts.push(host);
  const call = async <T>(path: string, body?: unknown) => {
    const r = await fetch(host.url + path.replace(/^\//, ""), {
      ...(body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as T & Err };
  };
  const create = async () => (await call<DraftView>("/api/drafts", {})).body;
  const stage = async (d: DraftView, objectId: string, field: string, value: unknown) =>
    call<DraftView>(`/api/drafts/${d.draftId}/stage`, { version: d.version, edit: { objectId, field, value } });
  return { host, stateDir, call, create, stage };
}

/** Stage a multi-module draft: rename Enrollment, revise a Notifications rule, rewire Web. */
async function multiModule(o: Awaited<ReturnType<typeof open>>) {
  let d = await o.create();
  d = (await o.stage(d, "mod-enrollment", "name", "Enrollments")).body;
  d = (await o.stage(d, "rul-recipient-required", "statement", "Listing notifications needs a recipientId.")).body;
  d = (await o.stage(d, "mod-web", "dependsOn", ["mod-enrollment"])).body;
  return d;
}

test("fields: editable ones name their typed operation; purpose and the rest are read-only with a reason", async () => {
  const { call } = await open(courseDesk());
  const mod = (await call<ModuleView>("/api/modules/mod-enrollment")).body;
  assert.deepEqual(
    mod.access.editable.map((f) => `${f.field}:${f.operation}`),
    ["name:renameObject", "description:setDescription", "dependsOn:setModuleDependencies"],
  );
  assert.match(mod.access.readOnly.find((f) => f.field === "purpose")?.reason ?? "", /No typed operation/);
  const rule = (await call<ObjectView>("/api/objects/rul-seat-limit")).body;
  assert.ok(rule.access.editable.some((f) => f.field === "statement" && f.operation === "setRuleStatement"));
  const attr = (await call<ObjectView>("/api/objects/att-course-title")).body;
  assert.equal(attr.access.editable.length, 0, "nested elements are read-only here");
});

test("(a) a multi-module draft holds ordered typed operations; preview and export never write the checkout", async () => {
  const repo = courseDesk();
  const before = tree(repo);
  const status = git(repo, "status", "--porcelain");
  const o = await open(repo);
  const d = await multiModule(o);
  assert.equal(d.version, 4);
  assert.deepEqual(
    d.steps.map((s) => s.operation),
    [
      { type: "renameObject", objectId: "mod-enrollment", name: "Enrollments" },
      {
        type: "setRuleStatement",
        ruleId: "rul-recipient-required",
        statement: "Listing notifications needs a recipientId.",
      },
      { type: "setModuleDependencies", moduleId: "mod-web", dependsOn: ["mod-enrollment"] },
    ],
  );
  // Correcting a field replaces its step in place; staging the model's own value removes it.
  let c = (await o.stage(d, "mod-enrollment", "name", "Enrolment")).body;
  assert.equal(c.steps[0]?.operation.name, "Enrolment");
  c = (await o.stage(c, "mod-enrollment", "name", "Enrollment")).body;
  assert.deepEqual(
    c.steps.map((s) => s.key),
    ["rul-recipient-required:statement", "mod-web:dependsOn"],
  );

  const p = await o.call<DraftPreview>(`/api/drafts/${d.draftId}/preview`, {});
  assert.equal(p.status, 200);
  assert.equal(p.body.origin, "unsubmitted");
  assert.equal(p.body.validation.appliesToCurrent, true);
  assert.deepEqual(
    p.body.delta?.changes.map((x) => `${x.id}:${x.fields.map((f) => f.field).join(",")}`),
    ["mod-web:dependsOn", "rul-recipient-required:statement"],
  );
  // Same answer as the repository layer's own dry run of the exported change.
  const e = (await o.call<DraftExport>(`/api/drafts/${d.draftId}/export`)).body;
  const direct = previewProposal(repo, { change: e.change });
  assert.ok(direct.ok);
  assert.deepEqual(p.body.validation.errors, direct.data.validation.errors);
  assert.deepEqual(p.body.delta?.changes, direct.data.delta?.changes);

  assert.deepEqual(tree(repo), before, "nothing under the checkout changed");
  assert.equal(git(repo, "status", "--porcelain"), status);
});

test("(e) the export is a strict ProposedModelChange the existing CLI previews; metadata travels apart", async () => {
  const repo = courseDesk();
  const o = await open(repo);
  let d = await multiModule(o);
  d = (
    await o.call<DraftView>(`/api/drafts/${d.draftId}/rationale`, { version: d.version, rationale: "Clearer names" })
  ).body;
  const { body: e } = await o.call<DraftExport>(`/api/drafts/${d.draftId}/export`);
  assert.equal(proposedChangeSchema.safeParse(e.change).success, true);
  assert.deepEqual(Object.keys(e.change).sort(), [
    "changeId",
    "expectedRevision",
    "operations",
    "projectId",
    "rationale",
  ]);
  assert.equal(e.change.changeId, `ui-${d.draftId.slice(2)}-v${d.version}`);
  assert.equal(e.change.expectedRevision, projectStatus(repo).model?.revision);
  for (const k of ["proposerId", "approverId", "status", "signature"]) assert.equal(k in e.change, false);
  assert.equal(e.metadata.check, "valid");
  assert.equal(e.metadata.needsAgent, false);
  assert.equal(e.metadata.draftId, d.draftId);

  const file = join(tempDir("vcv-export-"), e.fileName);
  writeFileSync(file, JSON.stringify(e.change, null, 2));
  const before = tree(repo);
  const cli = spawnSync(
    "node",
    ["--experimental-strip-types", "--no-warnings", CLI, "proposal", "preview", repo, "--file", file, "--json"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const out = JSON.parse(cli.stdout);
  assert.equal(out.data.proposal.origin, "unsubmitted");
  assert.equal(out.data.validation.appliesToCurrent, true);
  assert.deepEqual(
    out.data.proposal.operations.map((x: { type: string }) => x.type),
    ["renameObject", "setRuleStatement", "setModuleDependencies"],
  );
  assert.deepEqual(tree(repo), before, "the CLI preview writes nothing either");
});

test("an invalid operation is kept, reported by the engine and exported only as needing repair", async () => {
  const o = await open(courseDesk());
  let d = await o.create();
  d = (await o.stage(d, "mod-web", "name", "")).body;
  const p = (await o.call<DraftPreview>(`/api/drafts/${d.draftId}/preview`, {})).body;
  assert.equal(p.validation.appliesToCurrent, false);
  assert.match(JSON.stringify(p.validation.errors), /SCHEMA.*operations\.0\.name/);
  const e = (await o.call<DraftExport>(`/api/drafts/${d.draftId}/export`)).body;
  assert.equal(e.metadata.check, "invalid");
  assert.equal(e.metadata.needsAgent, true);
  assert.equal(proposedChangeSchema.safeParse(e.change).success, false, "labelled, never presented as valid");
});

test("(c) a revision change keeps the draft on R1: no restage, no new edits, export stays on R1 and needs an agent", async () => {
  const repo = courseDesk();
  const o = await open(repo);
  const r1 = projectStatus(repo).model?.revision as string;
  const d = await multiModule(o);
  const r2 = addAuditModule(repo);
  const after = tree(repo);
  const got = (await o.call<DraftView>(`/api/drafts/${d.draftId}`)).body;
  assert.equal(got.stale, true);
  assert.equal(got.base.revision, r1);
  assert.equal(got.current.revision, r2);
  assert.deepEqual(got.steps, d.steps, "operations unchanged");
  const refused = await o.stage(got, "mod-web", "name", "Web app");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error?.code, "DRAFT_STALE");
  const p = (await o.call<DraftPreview>(`/api/drafts/${d.draftId}/preview`, {})).body;
  assert.ok(p.validation.errors.some((x) => x.code === "STALE_REVISION"));
  const e = (await o.call<DraftExport>(`/api/drafts/${d.draftId}/export`)).body;
  assert.equal(e.change.expectedRevision, r1);
  assert.equal(e.metadata.check, "stale");
  assert.equal(e.metadata.needsAgent, true);
  assert.equal((await o.call(`/api/drafts/${d.draftId}/restage`, { version: got.version })).status, 404);
  assert.deepEqual(tree(repo), after, "R2 untouched");
});

test("(c) the same revision ID with another digest (a branch switch) also marks the draft stale", async () => {
  const repo = courseDesk();
  const o = await open(repo);
  const d = await multiModule(o);
  orphanBranchWithOtherModel(repo, "other", "Storefront");
  const got = (await o.call<DraftView>(`/api/drafts/${d.draftId}`)).body;
  assert.equal(got.current.revision, got.base.revision);
  assert.notEqual(got.current.modelKey, got.base.modelKey);
  assert.equal(got.stale, true);
  assert.equal((await o.call<DraftExport>(`/api/drafts/${d.draftId}/export`)).body.metadata.check, "stale");
  git(repo, "checkout", "-q", "main");
  assert.equal((await o.call<DraftView>(`/api/drafts/${d.draftId}`)).body.stale, false, "back on its base");
});

test("(b) drafts survive a host restart, stay apart from each other and from another checkout", async () => {
  const repo = courseDesk();
  const stateDir = tempDir("vcv-ui-state-");
  const first = await open(repo, stateDir);
  const a = await multiModule(first);
  let b = await first.create();
  b = (await first.stage(b, "rul-seat-limit", "statement", "Never more confirmed enrollments than seats.")).body;
  await first.host.close();

  const again = await open(repo, stateDir);
  const list = (await again.call<DraftList>("/api/drafts")).body;
  assert.deepEqual(list.drafts.map((x) => x.draftId).sort(), [a.draftId, b.draftId].sort());
  assert.deepEqual(list.drafts.find((x) => x.draftId === a.draftId)?.steps, a.steps);
  // Discarding one leaves the other alone.
  const gone = await again.call(`/api/drafts/${b.draftId}/discard`, { version: b.version });
  assert.equal(gone.status, 200);
  assert.deepEqual(
    (await again.call<DraftList>("/api/drafts")).body.drafts.map((x) => x.draftId),
    [a.draftId],
  );
  // Another checkout of the same project shares the state directory but not the drafts.
  const other = await open(courseDesk(), stateDir);
  assert.deepEqual((await other.call<DraftList>("/api/drafts")).body.drafts, []);
  assert.equal((await other.call(`/api/drafts/${a.draftId}`)).status, 404);
});

test("two tabs: an edit made on an old version is refused with the current draft; nothing is overwritten", async () => {
  const o = await open(courseDesk());
  const d = await o.create();
  const tab1 = (await o.stage(d, "mod-web", "name", "Web app")).body;
  const tab2 = await o.stage(d, "mod-enrollment", "name", "Enrollments"); // still on version 1
  assert.equal(tab2.status, 409);
  assert.equal(tab2.body.error?.code, "DRAFT_CONFLICT");
  assert.equal(tab2.body.current?.version, tab1.version);
  const now = (await o.call<DraftView>(`/api/drafts/${d.draftId}`)).body;
  assert.deepEqual(now.steps, tab1.steps);
  assert.equal((await o.call(`/api/drafts/${d.draftId}/discard`, { version: 1 })).status, 409, "stale discard refused");
});

test("(d) corrupt, oversized and foreign draft files are reported, never replaced, and discarded only on request", async () => {
  const repo = courseDesk();
  const o = await open(repo);
  const good = await multiModule(o);
  const store = new DraftFileStore(o.stateDir);
  const scope = { root: projectStatus(repo).root, projectId: "prj-course-desk" };
  const dir = store.dirFor(scope);
  const corrupt = "d-20260101-000000-aaaa";
  const large = "d-20260101-000000-bbbb";
  const foreign = "d-20260101-000000-cccc";
  writeFileSync(join(dir, `${corrupt}.json`), "{ not json");
  writeFileSync(join(dir, `${large}.json`), " ".repeat(DRAFT_LIMITS.fileBytes + 1));
  writeFileSync(
    join(dir, `${foreign}.json`),
    readFileSync(join(dir, `${good.draftId}.json`), "utf8").replace(`"prj-course-desk"`, `"prj-other"`),
  );
  const list = (await o.call<DraftList>("/api/drafts")).body;
  assert.deepEqual(
    list.drafts.map((x) => x.draftId),
    [good.draftId],
  );
  assert.deepEqual(
    list.problems.map((p) => `${p.draftId}:${p.code}`).sort(),
    [`${corrupt}:DRAFT_CORRUPT`, `${large}:DRAFT_TOO_LARGE`, `${foreign}:DRAFT_FOREIGN`].sort(),
  );
  assert.equal((await o.call(`/api/drafts/${corrupt}`)).status, 422);
  assert.equal(readFileSync(join(dir, `${corrupt}.json`), "utf8"), "{ not json", "left as it was");
  assert.equal((await o.call(`/api/drafts/${corrupt}/discard`, { version: null })).status, 200);
  assert.equal(
    (await o.call(`/api/drafts/${good.draftId}/discard`, { version: null })).status,
    409,
    "a readable draft needs its version",
  );
  assert.ok(!readdirSync(dir).includes(`${corrupt}.json`));
});

test("bad input is refused: unknown objects, read-only fields, oversized bodies, bad IDs; no submit or approve route", async () => {
  const o = await open(courseDesk());
  const d = await o.create();
  const code = async (r: Promise<{ body: Err }>) => (await r).body.error?.code;
  assert.equal(await code(o.stage(d, "mod-nowhere", "name", "x")), "INVALID_EDIT");
  assert.equal(await code(o.stage(d, "mod-web", "purpose", "x")), "INVALID_EDIT");
  assert.equal(await code(o.stage(d, "cap-enroll", "dependsOn", [])), "INVALID_EDIT");
  assert.equal(await code(o.stage(d, "mod-web", "name", 42)), "INVALID_EDIT");
  assert.equal(await code(o.stage(d, "mod-web", "description", "x".repeat(70_000))), "INVALID_REQUEST");
  assert.equal(
    await code(o.call(`/api/drafts/${d.draftId}/stage`, { edit: { objectId: "mod-web", field: "name", value: "a" } })),
    "INVALID_REQUEST",
  );
  assert.equal((await o.call("/api/drafts/not-a-draft")).status, 404);
  assert.equal((await o.call(`/api/drafts/${d.draftId}/preview`, {})).body.error?.code, "EMPTY_DRAFT");
  for (const path of [`/api/drafts/${d.draftId}/submit`, `/api/drafts/${d.draftId}/approve`])
    assert.equal((await o.call(path, {})).status, 404, path);
  // The proposal inbox (M5.4) is read-only: any write there is refused, not routed.
  assert.equal((await o.call("/api/proposals/submit", {})).status, 405);
});

test("drafts are refused while the project is not ready, and nothing is written", async () => {
  const repo = courseDesk();
  mkdirSync(join(repo, ".vcv", "x"), { recursive: true });
  writeFileSync(join(repo, ".vcv", "HEAD"), "garbage\n");
  const before = tree(repo);
  const o = await open(repo);
  assert.equal((await o.call("/api/drafts")).status, 409);
  assert.equal((await o.call("/api/drafts", {})).status, 409);
  assert.deepEqual(tree(repo), before);
});
