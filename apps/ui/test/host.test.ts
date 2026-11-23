// The UI host against real checkouts, over HTTP: what the browser can read and do.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadModel } from "@vcv/ir";
import { moduleGraph } from "../src/graph.ts";
import { LayoutFileStore } from "../src/layout-store.ts";
import { startHost } from "../src/server.ts";
import type { Host } from "../src/server.ts";
import { ProjectSession } from "../src/session.ts";
import type { ModuleView, ObjectView, ProjectView } from "../src/types.ts";
import {
  addAuditModule,
  addWebCriterion,
  orphanBranchWithOtherModel,
  renameModule,
  conflictedRepo,
  courseDesk,
  DRAFT,
  emptyRepo,
  git,
  invalidRepo,
  tempDir,
  tree,
  uninitializedRepo,
} from "./fixtures.ts";

const hosts: Host[] = [];
after(() => Promise.all(hosts.map((h) => h.close())));

async function open(repo: string, stateDir = tempDir("vcv-ui-state-")) {
  const host = await startHost({ session: new ProjectSession(repo, new LayoutFileStore(stateDir)), webDir: tempDir() });
  hosts.push(host);
  const get = async <T>(path: string) => {
    const r = await fetch(host.url + path.replace(/^\//, ""));
    return { status: r.status, body: (await r.json()) as T };
  };
  const post = async <T>(path: string, body: unknown) => {
    const r = await fetch(host.url + path.replace(/^\//, ""), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as T };
  };
  return { host, stateDir, get, post };
}

test("graph projection: direction comes from the declaring dependsOn field", () => {
  const model = loadModel(readFileSync(DRAFT, "utf8")).model!;
  const g = moduleGraph(model, {
    modules: model.modules.map((m) => ({
      id: m.id,
      kind: "module" as const,
      name: m.name,
      irPath: "",
      dependsOn: [],
      consumes: [],
      exposes: [],
      counts: { dependsOn: 0, consumes: 0, exposes: 0 },
      owned: {},
    })),
  });
  assert.deepEqual(
    g.edges.map((e) => `${e.from}->${e.to}`),
    ["mod-enrollment->mod-notifications", "mod-web->mod-enrollment", "mod-web->mod-notifications"],
  );
  assert.ok(g.edges.every((e) => e.kind === "dependsOn" && e.declaredAt.startsWith("modules[")));
});

test("a ready checkout: modules, directed edges, inspector and object detail come from the model", async () => {
  const repo = courseDesk();
  const before = tree(repo);
  const { get } = await open(repo);
  const { status, body } = await get<ProjectView>("/api/project");
  assert.equal(status, 200);
  assert.equal(body.observation.state, "ready");
  assert.equal(body.observation.git?.branch, "main");
  const g = body.graph!;
  assert.equal(g.revision, "rev-1");
  assert.deepEqual(g.modules.map((m) => m.name).sort(), ["Enrollment", "Notifications", "Web"]);
  assert.ok(g.edges.some((e) => e.from === "mod-enrollment" && e.to === "mod-notifications"));
  assert.ok(!g.edges.some((e) => e.from === "mod-notifications" && e.to === "mod-enrollment"), "never reversed");
  assert.ok(g.positions["mod-web"]!.y < g.positions["mod-enrollment"]!.y, "dependents above dependencies");
  assert.deepEqual(g.placed, [], "a first open announces nothing as new");

  const m = await get<ModuleView>("/api/modules/mod-enrollment");
  assert.equal(m.status, 200);
  assert.equal(m.body.module.purpose, "Holds the course catalog and decides, records and exposes enrollments.");
  assert.deepEqual(
    m.body.dependsOn.map((d) => d.id),
    ["mod-notifications"],
  );
  assert.deepEqual(
    m.body.usedBy.map((d) => d.id),
    ["mod-web"],
  );
  assert.ok(m.body.owned.capability!.some((c) => c.name === "Enroll in a course"));
  assert.ok(m.body.owned.rule!.some((r) => r.id === "rul-seat-limit" && r.facts.includes("invariant")));

  const o = await get<ObjectView>("/api/objects/dat-enrollment");
  assert.equal(o.status, 200);
  assert.equal(o.body.object.kind, "data");
  assert.ok(o.body.relations.some((r) => r.relation === "owner" && r.other.id === "mod-enrollment"));

  assert.equal((await get("/api/modules/cap-enroll")).status, 404, "not a module");
  assert.equal((await get("/api/modules/mod-nope")).status, 404);
  assert.deepEqual(tree(repo), before, "reading wrote nothing in the checkout");
});

test("pin persists outside the checkout across a restart; tidy and unpin never touch the model", async () => {
  const repo = courseDesk();
  const before = tree(repo);
  const first = await open(repo);
  const pinned = await first.post<{ positions: Record<string, { x: number; y: number; pinned: boolean }> }>(
    "/api/layout/pin",
    { id: "mod-notifications", x: 640, y: 480 },
  );
  assert.equal(pinned.status, 200);
  assert.deepEqual(pinned.body.positions["mod-notifications"], { x: 640, y: 480, pinned: true });
  await first.post("/api/layout/tidy", {});
  await first.host.close();

  const again = await open(repo, first.stateDir); // a relaunch with the same state directory
  const g = (await again.get<ProjectView>("/api/project")).body.graph!;
  assert.deepEqual(g.positions["mod-notifications"], { x: 640, y: 480, pinned: true });
  assert.equal(g.revision, "rev-1", "no revision was minted");
  assert.deepEqual(tree(repo), before, "nothing under the checkout changed");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.ok(readdirSync(first.stateDir).some((f) => f.startsWith("layout-")));

  const unpinned = await again.post<{ positions: Record<string, { pinned: boolean }> }>("/api/layout/unpin", {
    id: "mod-notifications",
  });
  assert.equal(unpinned.body.positions["mod-notifications"]!.pinned, false);
  assert.equal((await again.post("/api/layout/pin", { id: "mod-nope", x: 1, y: 1 })).status, 404);
  assert.equal((await again.post("/api/layout/pin", { id: "mod-web" })).status, 400);
});

test("a later revision: pinned modules stay put, the new module is placed and announced", async () => {
  const repo = courseDesk();
  const { get, post } = await open(repo);
  const initial = (await get<ProjectView>("/api/project")).body.graph!;
  await post("/api/layout/pin", { id: "mod-notifications", x: 700, y: 900 });

  git(repo, "checkout", "-q", "-b", "feature/audit");
  const rev = addAuditModule(repo);
  const view = (await get<ProjectView>("/api/project")).body;
  const g = view.graph!;
  assert.equal(g.revision, rev);
  assert.deepEqual(g.positions["mod-notifications"], { x: 700, y: 900, pinned: true });
  assert.deepEqual(g.positions["mod-web"], initial.positions["mod-web"]);
  assert.deepEqual(g.positions["mod-enrollment"], initial.positions["mod-enrollment"]);
  assert.deepEqual(g.placed, ["mod-audit"]);
  assert.ok(g.edges.some((e) => e.from === "mod-audit" && e.to === "mod-enrollment"));
  assert.equal(view.lastChange?.modelLine, "advanced");
  assert.deepEqual(view.lastChange?.added, ["mod-audit"]);
  assert.equal(view.lastChange?.after.branch, "feature/audit");

  git(repo, "checkout", "-q", "main");
  const back = (await get<ProjectView>("/api/project")).body;
  assert.equal(back.lastChange?.modelLine, "rewound");
  assert.deepEqual(back.lastChange?.removed, ["mod-audit"]);
  assert.equal(back.graph!.positions["mod-audit"], undefined);
});

test("absent, uninitialized, conflicted and invalid checkouts are reported truthfully and left untouched", async () => {
  const cases: [string, string, string][] = [
    [emptyRepo(), "absent", "NO_PROJECT"],
    [uninitializedRepo(), "uninitialized", "NOT_INITIALIZED"],
    [conflictedRepo(), "conflicted", "CONFLICTED"],
    [invalidRepo(), "invalid", "INVALID_STORE"],
  ];
  for (const [repo, state, code] of cases) {
    const before = tree(repo);
    const { get, post } = await open(repo);
    const { status, body } = await get<ProjectView>("/api/project");
    assert.equal(status, 200);
    assert.equal(body.observation.state, state);
    assert.equal(body.graph, null);
    assert.ok(
      body.observation.diagnostics.some((d) => d.code === code),
      `${state}: ${code}`,
    );
    assert.equal((await get("/api/modules/mod-web")).status, 409);
    assert.equal((await post("/api/layout/tidy", {})).status, 409);
    assert.deepEqual(tree(repo), before, `${state}: nothing created, repaired or overwritten`);
    if (state === "absent") assert.ok(!existsSync(join(repo, ".vcv")));
  }
});

test("the host refuses foreign Host and Origin headers and non-JSON writes", async () => {
  const { host } = await open(courseDesk());
  const url = new URL(host.url);
  const raw = (headers: Record<string, string>, init: RequestInit = {}) =>
    fetch(`${host.url}api/project`, { ...init, headers }).then((r) => r.status);
  assert.equal(await raw({ origin: "http://evil.example" }), 403);
  assert.equal(await raw({ origin: `http://127.0.0.1:${url.port}` }), 200);
  const rebound = await new Promise<number>((ok) => {
    import("node:http").then(({ request }) => {
      const req = request(
        { host: "127.0.0.1", port: url.port, path: "/api/project", headers: { host: `attacker.example:${url.port}` } },
        (res) => ok(res.statusCode ?? 0),
      );
      req.end();
    });
  });
  assert.equal(rebound, 403, "DNS rebinding: wrong Host header");
  const form = await fetch(`${host.url}api/layout/tidy`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "a=1",
  });
  assert.equal(form.status, 400);
});

test("a corrupt layout file reads as no layout", async () => {
  const repo = courseDesk();
  const stateDir = tempDir("vcv-ui-state-");
  const store = new LayoutFileStore(stateDir);
  writeFileSync(store.pathFor(repo, "prj-course-desk"), "{ not json");
  const { get } = await open(repo, stateDir);
  const g = (await get<ProjectView>("/api/project")).body.graph!;
  assert.equal(Object.keys(g.positions).length, 3);
});

test("model identity: the same revision ID on two branches is told apart, and inspector answers carry it", async () => {
  const repo = courseDesk();
  const { get } = await open(repo);
  const main = (await get<ProjectView>("/api/project")).body;
  orphanBranchWithOtherModel(repo, "other", "Web (other)");
  const other = (await get<ProjectView>("/api/project")).body;
  assert.equal(other.graph!.revision, main.graph!.revision, "both are rev-1");
  assert.notEqual(other.graph!.modelKey, main.graph!.modelKey);
  assert.equal(other.observation.model!.key, other.graph!.modelKey);
  assert.equal(other.lastChange?.modelLine, "switched");
  const m = await get<ModuleView>("/api/modules/mod-web");
  assert.equal(m.body.modelKey, other.graph!.modelKey);
  assert.equal(m.body.module.name, "Web (other)");
});

test("a checkout that moves mid-read is read again: status, Git and model always belong together", async () => {
  const repo = courseDesk();
  git(repo, "checkout", "-q", "-b", "renamed");
  const renamedRev = renameModule(repo, "chg-rename", "mod-enrollment", "Enrollment (renamed)");
  git(repo, "checkout", "-q", "main");
  let switches = 1;
  const session = new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-")), {
    afterModelRead: () => {
      if (switches-- > 0) git(repo, "checkout", "-q", "renamed"); // a branch switch between model read and re-check
    },
  });
  const view = session.view();
  assert.equal(view.observation.git?.branch, "renamed");
  assert.equal(view.graph!.revision, renamedRev);
  assert.equal(view.observation.model!.key, view.graph!.modelKey);
  assert.ok(view.graph!.modules.some((m) => m.name === "Enrollment (renamed)"));

  let forever = 0;
  const restless = new ProjectSession(repo, new LayoutFileStore(tempDir("vcv-ui-state-")), {
    afterModelRead: () => git(repo, "checkout", "-q", forever++ % 2 ? "renamed" : "main"),
  });
  assert.throws(
    () => restless.view(),
    (e: unknown) => (e as { code?: string }).code === "STATE_CHANGED",
  );
});

test("object relations name the module that owns the related object", async () => {
  const repo = courseDesk();
  addWebCriterion(repo);
  const { get } = await open(repo);
  const o = await get<ObjectView>("/api/objects/crt-page-enrolls");
  assert.equal(o.body.object.moduleId, "mod-web");
  const verifies = o.body.relations.find((r) => r.relation === "verifies");
  assert.equal(verifies?.other.id, "cap-enroll");
  assert.equal(verifies?.other.moduleId, "mod-enrollment", "owned by Enrollment, not by Web");
  const cap = await get<ObjectView>("/api/objects/cap-enroll");
  assert.equal(cap.body.object.moduleId, "mod-enrollment");
  const initiator = cap.body.relations.find((r) => r.other.kind === "actor");
  assert.equal(initiator?.other.moduleId, undefined, "actors belong to the project");
});
