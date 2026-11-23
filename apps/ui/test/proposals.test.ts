// Inspector edits as typed proposals, over HTTP on real checkouts: what can be edited, the dry
// run, a pending proposal that never moves .vcv/HEAD, and drafts that no longer fit the model.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { projectStatus } from "@vcv/repo";
import { toOperations } from "../src/edits.ts";
import { LayoutFileStore } from "../src/layout-store.ts";
import { newChangeId } from "../src/proposals.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProjectSession } from "../src/session.ts";
import type { DraftPreview, ModuleView, ObjectView, ProjectView, ProposalsView, SubmitView } from "../src/types.ts";
import { addAuditModule, courseDesk, git, orphanBranchWithOtherModel, tempDir, tree } from "./fixtures.ts";

const hosts: Host[] = [];
after(() => Promise.all(hosts.map((h) => h.close())));

async function open(repo: string) {
  const session = new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-")));
  const host = await startHost({ session, webDir: tempDir(), proposer: "user:hoang" });
  hosts.push(host);
  const call = async <T>(path: string, body?: unknown) => {
    const r = await fetch(host.url + path.replace(/^\//, ""), {
      ...(body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as T & { error?: { code: string; message: string } } };
  };
  const { body: view } = await call<ProjectView>("/api/project");
  const base = { expectedRevision: view.graph!.revision, modelKey: view.graph!.modelKey };
  return { call, base };
}

/** Change records this UI wrote (the fixtures' own records are named chg-*). */
const records = (repo: string) => {
  try {
    return readdirSync(join(repo, ".vcv", "changes")).filter((f) => f.startsWith("ui-"));
  } catch {
    return [];
  }
};

test("the inspector says which fields are editable, by which typed operation, and why the rest is not", async () => {
  const { call } = await open(courseDesk());
  const mod = (await call<ModuleView>("/api/modules/mod-enrollment")).body;
  assert.deepEqual(
    mod.access.editable.map((f) => `${f.field}:${f.operation}`),
    ["name:renameObject", "description:setDescription", "dependsOn:setModuleDependencies"],
  );
  assert.deepEqual(mod.access.editable.find((f) => f.field === "dependsOn")?.value, ["mod-notifications"]);
  const purpose = mod.access.readOnly.find((f) => f.field === "purpose");
  assert.match(purpose?.reason ?? "", /No typed operation/);

  const rule = (await call<ObjectView>("/api/objects/rul-seat-limit")).body;
  assert.ok(rule.access.editable.some((f) => f.field === "statement" && f.operation === "setRuleStatement"));
  assert.ok(rule.access.readOnly.some((f) => f.field === "owner"));

  const attr = (await call<ObjectView>("/api/objects/att-course-title")).body;
  assert.equal(attr.access.editable.length, 0, "nested elements are read-only here");
});

test("preview is a dry run: engine validation, delta and impact, and nothing is written", async () => {
  const repo = courseDesk();
  const before = tree(repo);
  const { call, base } = await open(repo);
  const r = await call<DraftPreview>("/api/proposals/preview", {
    ...base,
    rationale: "Clearer name",
    edits: [
      { objectId: "mod-enrollment", field: "name", value: "Enrollments" },
      { objectId: "rul-seat-limit", field: "statement", value: "A course never has more enrollments than seats." },
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.operations.map((o) => o.type),
    ["renameObject", "setRuleStatement"],
  );
  assert.equal(r.body.validation.appliesToCurrent, true);
  assert.deepEqual(r.body.validation.errors, []);
  assert.deepEqual(
    r.body.delta?.changes.map((c) => `${c.id}:${c.change}:${c.fields.map((f) => f.field).join(",")}`),
    ["mod-enrollment:modified:name", "rul-seat-limit:modified:statement"],
  );
  assert.ok(r.body.impact?.modules.some((m) => m.id === "mod-enrollment"));
  assert.deepEqual(tree(repo), before, "a preview writes nothing");
});

test("the engine's validation errors come back verbatim; a failing draft is never recorded", async () => {
  const repo = courseDesk();
  const { call, base } = await open(repo);
  // A dependency on a module that does not exist is a typed operation the engine rejects.
  const edits = [{ objectId: "mod-web", field: "dependsOn", value: ["mod-enrollment", "mod-nowhere"] }];
  const p = await call<DraftPreview>("/api/proposals/preview", { ...base, edits });
  assert.equal(p.status, 200);
  assert.ok(p.body.validation.errors.length > 0);
  const s = await call<SubmitView>("/api/proposals/submit", { ...base, edits });
  assert.equal(s.status, 422);
  assert.equal(s.body.status, "not-submitted");
  assert.equal(s.body.recorded, false);
  assert.deepEqual(records(repo), []);
});

test("submit records a pending proposal for the host's proposer; .vcv/HEAD and Git stay where they were", async () => {
  const repo = courseDesk();
  const head = git(repo, "rev-parse", "HEAD");
  const revision = projectStatus(repo).model?.revision;
  const { call, base } = await open(repo);
  const s = await call<SubmitView>("/api/proposals/submit", {
    ...base,
    rationale: "Name it for what it holds",
    edits: [{ objectId: "mod-enrollment", field: "description", value: "Seats, enrollments and their decisions." }],
  });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.status, "pending");
  assert.match(s.body.changeId ?? "", /^ui-\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.equal(s.body.proposerId, "user:hoang");
  assert.deepEqual(s.body.modelRevision, { before: revision, after: revision });
  assert.match(s.body.commands?.approve ?? "", /^vcv review approve .* --digest [0-9a-f]+ /);
  assert.equal(projectStatus(repo).model?.revision, revision);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);

  const list = await call<ProposalsView>("/api/proposals");
  assert.deepEqual(
    list.body.proposals.map((p) => [p.changeId, p.lifecycle, p.proposerId, p.operations]),
    [[s.body.changeId, "pending", "user:hoang", 1]],
  );
  // The model the canvas shows is unchanged: a pending proposal is not the model.
  const mod = (await call<ModuleView>("/api/modules/mod-enrollment")).body;
  assert.notEqual(mod.module.description, "Seats, enrollments and their decisions.");
});

test("a draft staged on an older revision keeps its expectedRevision and is reported stale by the engine", async () => {
  const repo = courseDesk();
  const { call, base } = await open(repo);
  addAuditModule(repo); // the model advances under the draft
  const edits = [{ objectId: "mod-web", field: "name", value: "Web app" }];
  const p = await call<DraftPreview>("/api/proposals/preview", { ...base, edits });
  assert.equal(p.status, 200);
  assert.equal(p.body.expectedRevision, base.expectedRevision);
  assert.notEqual(p.body.currentRevision, base.expectedRevision);
  assert.equal(p.body.validation.appliesToCurrent, false);
  assert.ok(p.body.validation.errors.some((e) => e.code === "STALE_REVISION"));
  const s = await call<SubmitView>("/api/proposals/submit", { ...base, edits });
  assert.equal(s.status, 422);
  assert.equal(s.body.recorded, false);
  assert.deepEqual(records(repo), []);
});

test("a draft from another model under the same revision ID is refused before it is read", async () => {
  const repo = courseDesk();
  const { call, base } = await open(repo);
  orphanBranchWithOtherModel(repo, "other", "Storefront");
  const r = await call("/api/proposals/preview", {
    ...base,
    edits: [{ objectId: "mod-web", field: "name", value: "Web app" }],
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error?.code, "STALE_DRAFT");
});

test("edits outside the table are refused: unknown objects, read-only fields, duplicates, no approve route", async () => {
  const { call, base } = await open(courseDesk());
  const bad = async (edits: unknown) => (await call("/api/proposals/preview", { ...base, edits })).body.error?.code;
  assert.equal(await bad([{ objectId: "mod-nowhere", field: "name", value: "x" }]), "INVALID_EDIT");
  assert.equal(await bad([{ objectId: "mod-web", field: "purpose", value: "x" }]), "INVALID_EDIT");
  assert.equal(await bad([{ objectId: "cap-enroll", field: "dependsOn", value: [] }]), "INVALID_EDIT");
  assert.equal(
    await bad([
      { objectId: "mod-web", field: "name", value: "a" },
      { objectId: "mod-web", field: "name", value: "b" },
    ]),
    "INVALID_EDIT",
  );
  assert.equal(await bad([]), "INVALID_EDIT");
  assert.equal((await call("/api/proposals/approve", { ...base })).status, 404);
  assert.equal((await call("/api/proposals/preview", { edits: [] })).status, 400);
});

test("toOperations maps each editable field to its one typed operation", () => {
  const model = {
    project: { id: "prj", name: "P", modelRevision: "rev-1", status: "draft" },
    modules: [{ id: "mod-a", kind: "module", owner: "prj", name: "A" }],
    rules: [{ id: "rul-a", kind: "rule", owner: "mod-a", name: "R", ruleKind: "invariant", statement: "s" }],
    criteria: [
      {
        id: "c-1",
        kind: "criterion",
        owner: "mod-a",
        name: "C",
        statement: "s",
        verifies: [],
        verification: "optional",
      },
    ],
    actors: [],
    capabilities: [],
    data: [],
    events: [],
    contracts: [],
    behaviors: [],
  } as never;
  assert.deepEqual(
    toOperations(model, [
      { objectId: "mod-a", field: "dependsOn", value: [] },
      { objectId: "rul-a", field: "statement", value: "t" },
      { objectId: "c-1", field: "statement", value: "u" },
    ]),
    [
      { type: "setModuleDependencies", moduleId: "mod-a", dependsOn: [] },
      { type: "setRuleStatement", ruleId: "rul-a", statement: "t" },
      { type: "reviseCriterion", criterionId: "c-1", statement: "u" },
    ],
  );
  assert.match(newChangeId(new Date("2026-11-23T10:15:00Z")), /^ui-20261123-101500-[0-9a-f]{4}$/);
});
