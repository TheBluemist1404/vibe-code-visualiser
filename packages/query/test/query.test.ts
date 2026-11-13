import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadModel } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import { FileStore, MemoryStore, ModelEngine } from "@vcv/core";
import { LIMITS, createQueryApi } from "../src/index.ts";
import type { QueryResult } from "../src/index.ts";
import { tempDir } from "@vcv/testkit";

const FIXTURE = join(import.meta.dirname, "../../../examples/enrollment/model.rev-1.yaml");
const model = (): Model => loadModel(readFileSync(FIXTURE, "utf8")).model!;
const api = (m = model()) => createQueryApi(new MemoryStore(m));
function data<T>(r: QueryResult<T>): T {
  assert.ok(r.ok, `query failed: ${JSON.stringify(!r.ok && r.error)}`);
  return r.data;
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("every response carries the model-only provenance envelope", () => {
  const q = api();
  for (const r of [
    q.getProjectOverview(),
    q.searchObjects({ text: "enrollment" }),
    q.getContext({ id: "mod-enrollment" }),
    q.analyzeImpact({ ids: ["evt-enrollment-rejected"] }),
  ]) {
    assert.ok(r.ok);
    assert.deepEqual(r.context, {
      projectId: "prj-lms",
      modelRevision: "rev-1",
      snapshotStatus: "approved",
      source: "canonical-ir",
      coverage: "model-only",
      implementationChecked: false,
    });
  }
});

test("getProjectOverview summarizes modules, their boundaries and the inventory", () => {
  const o = data(api().getProjectOverview());
  assert.deepEqual(o.project, { id: "prj-lms", name: "LMS", schemaVersion: "0.2" });
  assert.deepEqual(ids(o.modules), ["mod-enrollment", "mod-notifications"]);
  const [enr, notif] = o.modules;
  assert.deepEqual(enr!.exposes, ["ctr-enrollment-events", "ctr-enrollment-review"]);
  assert.deepEqual(notif!.consumes, ["ctr-enrollment-events"]);
  assert.deepEqual(notif!.dependsOn, ["mod-enrollment"]);
  assert.deepEqual(enr!.owned, {
    attribute: 2,
    behavior: 1,
    capability: 1,
    contract: 2,
    data: 1,
    event: 3,
    rule: 2,
    state: 3,
    transition: 2,
  });
  assert.equal(o.inventory.module, 2);
  assert.deepEqual(o.validation, { errors: 0, warnings: 0 });
});

test("searching for enrollment and notifications discovers both modules", () => {
  const r = data(api().searchObjects({ text: "enrollment notifications", kinds: ["module"] }));
  assert.deepEqual(ids(r.hits).sort(), ["mod-enrollment", "mod-notifications"]);
  assert.equal(r.total, 2);

  const all = data(api().searchObjects({ text: "enrollment notifications", limit: 5 }));
  assert.ok(
    ids(all.hits).includes("mod-enrollment") && ids(all.hits).includes("mod-notifications"),
    "modules rank in the top 5 unfiltered",
  );
  const hit = all.hits.find((h) => h.id === "mod-notifications")!;
  assert.deepEqual(hit.matchedFields, ["id", "name"]);
  assert.equal(hit.moduleId, "mod-notifications");
});

test("search finds word variants and nested elements, with deterministic order", () => {
  const q = api();
  const r = data(q.searchObjects({ text: "rejection", kinds: ["event", "state"] }));
  assert.deepEqual(ids(r.hits), ["evt-rejection-submitted", "evt-enrollment-rejected", "st-rejected"]);
  assert.equal(r.hits.find((h) => h.id === "st-rejected")!.parentId, "beh-enrollment-approval");
  assert.deepEqual(
    data(q.searchObjects({ text: "rejection", kinds: ["event", "state"] })),
    r,
    "same input, same output",
  );
  assert.equal(data(q.searchObjects({ text: "zzz-nothing" })).total, 0);
});

test("search pages are bounded and the cursor is bound to the revision", () => {
  const m = model();
  const store = new MemoryStore(m);
  const q = createQueryApi(store);
  const first = data(q.searchObjects({ text: "enrollment", limit: 3 }));
  assert.equal(first.hits.length, 3);
  assert.equal(first.truncated, true);
  const second = data(q.searchObjects({ text: "enrollment", limit: 3, cursor: first.nextCursor }));
  assert.equal(second.hits.length, 3);
  assert.equal(new Set([...ids(first.hits), ...ids(second.hits)]).size, 6, "pages do not overlap");

  // After a model change the old cursor is refused instead of silently skipping results.
  new ModelEngine(store).propose(
    {
      changeId: "ch-rename",
      projectId: "prj-lms",
      expectedRevision: "rev-1",
      operations: [{ type: "renameObject", objectId: "mod-enrollment", name: "Enrolment" }],
    },
    { principalId: "user:hoang", permissions: ["model:propose", "model:apply"] },
  );
  const stale = q.searchObjects({ text: "enrollment", limit: 3, cursor: first.nextCursor });
  assert.ok(!stale.ok);
  assert.equal(stale.error.code, "REVISION_MISMATCH");
  const bad = q.searchObjects({ text: "enrollment", cursor: "garbage" });
  assert.ok(!bad.ok && bad.error.code === "INVALID_CURSOR");
});

test("inspecting the rejection event reveals the publishing contract and who consumes it", () => {
  const c = data(api().getContext({ id: "evt-enrollment-rejected", depth: 2 }));
  assert.equal(c.focus.kind, "event");
  assert.equal(c.focus.moduleId, "mod-enrollment");
  const edge = (from: string, relation: string, to: string) =>
    c.edges.some((e) => e.from === from && e.relation === relation && e.to === to);
  assert.ok(
    edge("ctr-enrollment-events", "contractPublishes", "evt-enrollment-rejected"),
    "contract publishes the event",
  );
  assert.ok(
    edge("mod-notifications", "consumes", "ctr-enrollment-events"),
    "Notifications consumes that contract (2 hops)",
  );
  assert.ok(
    edge("tr-send-notice", "triggerEvent", "evt-enrollment-rejected"),
    "Notifications behavior is triggered by it",
  );
  assert.ok(edge("tr-reject", "effectEvent", "evt-enrollment-rejected"), "Enrollment behavior emits it");
  assert.equal(c.edges.find((e) => e.relation === "contractPublishes")!.category, "contract");
  assert.equal(c.nodes.find((n) => n.id === "mod-notifications")!.distance, 2);
  // Depth 2 does not flood the budget with every sibling owned by mod-enrollment.
  assert.ok(!ids(c.nodes).includes("cap-review-enrollment"));
});

test("getContext honours direction, relation filters, depth and node budgets", () => {
  const q = api();
  const outOnly = data(q.getContext({ id: "tr-send-notice", direction: "outgoing" }));
  assert.ok(outOnly.edges.every((e) => e.from === "tr-send-notice"));
  assert.deepEqual(ids(outOnly.nodes).sort(), ["evt-enrollment-rejected", "st-notice-sent", "st-notice-waiting"]);

  const filtered = data(
    q.getContext({ id: "evt-enrollment-rejected", relations: ["contractPublishes", "consumes"], depth: 2 }),
  );
  assert.deepEqual(ids(filtered.nodes), ["ctr-enrollment-events", "mod-notifications"]);

  const small = data(q.getContext({ id: "mod-enrollment", maxNodes: 4 }));
  assert.equal(small.nodes.length, 4);
  assert.equal(small.truncated, true);
  const full = data(q.getContext({ id: "mod-enrollment", maxNodes: 200 }));
  assert.equal(
    full.nodes.every((n) => n.distance === 1),
    true,
  );
  assert.equal(full.budget.depth, 1);
  assert.equal(data(q.getContext({ id: "evt-enrollment-rejected", depth: 1 })).truncated, true, "depth limit reported");
});

test("analyzeImpact follows typed references and explains why each candidate may be affected", () => {
  const r = data(api().analyzeImpact({ ids: ["evt-enrollment-rejected"] }));
  assert.equal(r.impactClass, "structural-candidate");
  assert.match(r.note, /not.*checked/i);
  const byId = new Map(r.candidates.map((c) => [c.id, c]));

  const notif = byId.get("mod-notifications")!;
  assert.equal(notif.via, "dependent");
  assert.equal(notif.distance, 2);
  assert.deepEqual(notif.dependencyPath, [
    { from: "evt-enrollment-rejected", relation: "contractPublishes", to: "ctr-enrollment-events" },
    { from: "ctr-enrollment-events", relation: "consumes", to: "mod-notifications" },
  ]);
  assert.match(notif.reason, /consumes this contract.*contract publishes this event/);

  assert.equal(byId.get("tr-send-notice")!.via, "dependent");
  assert.equal(byId.get("beh-rejection-notice")!.via, "container");
  assert.equal(byId.get("mod-enrollment")!.via, "container");
  // Things that merely live in the same module are not candidates.
  assert.ok(!byId.has("cap-review-enrollment"));
  assert.ok(!byId.has("evt-enrollment-rejected"), "seeds are not their own candidates");
  assert.deepEqual(
    r.candidates.map((c) => c.distance),
    [...r.candidates.map((c) => c.distance)].sort((a, b) => a - b),
    "ordered by distance",
  );
});

test("analyzeImpact respects depth and result limits", () => {
  const q = api();
  const shallow = data(q.analyzeImpact({ ids: ["evt-enrollment-rejected"], maxDepth: 1 }));
  assert.ok(shallow.candidates.every((c) => c.distance === 1));
  assert.ok(!ids(shallow.candidates).includes("mod-notifications"));
  assert.equal(shallow.truncated, true);
  const few = data(q.analyzeImpact({ ids: ["attr-request-created-at", "st-pending"], maxResults: 2 }));
  assert.equal(few.candidates.length, 2);
  assert.equal(few.truncated, true);
});

test("unknown IDs and invalid queries return structured errors", () => {
  const q = api();
  const unknown = q.getContext({ id: "mod-nope" });
  assert.ok(!unknown.ok && unknown.error.code === "UNKNOWN_ID" && unknown.context?.modelRevision === "rev-1");
  const someUnknown = q.analyzeImpact({ ids: ["evt-enrollment-rejected", "evt-nope"] });
  assert.ok(!someUnknown.ok && someUnknown.error.code === "UNKNOWN_ID" && /evt-nope/.test(someUnknown.error.message));

  const cases: [string, QueryResult<unknown>][] = [
    ["depth too large", q.getContext({ id: "mod-enrollment", depth: 9 })],
    ["unknown relation", q.getContext({ id: "mod-enrollment", relations: ["friendOf" as never] })],
    ["unsupported option", q.getContext({ id: "mod-enrollment", includeCode: true } as never)],
    ["empty text", q.searchObjects({ text: "   " })],
    ["bad kind", q.searchObjects({ text: "x", kinds: ["table" as never] })],
    ["limit too large", q.searchObjects({ text: "enrollment", limit: 1000 })],
    ["no seeds", q.analyzeImpact({ ids: [] })],
    ["too many kinds", q.searchObjects({ text: "x", kinds: Array(LIMITS.search.maxKinds + 1).fill("module") })],
    [
      "too many relations",
      q.getContext({ id: "mod-enrollment", relations: Array(LIMITS.context.maxRelations + 1).fill("consumes") }),
    ],
    ["not an object", q.searchObjects(null as never)],
  ];
  for (const [label, r] of cases) {
    assert.ok(!r.ok, `${label} should fail`);
    assert.equal(r.error.code, "INVALID_REQUEST", label);
    assert.ok(r.error.details?.length, `${label} explains which field`);
  }
  const punctuation = q.searchObjects({ text: "!!" });
  assert.ok(!punctuation.ok && punctuation.error.code === "INVALID_REQUEST");
});

test("expectedRevision lets a multi-call agent detect that the model moved", () => {
  const q = api();
  assert.ok(q.getProjectOverview({ expectedRevision: "rev-1" }).ok);
  const moved = q.getContext({ id: "mod-enrollment", expectedRevision: "rev-0" });
  assert.ok(!moved.ok && moved.error.code === "REVISION_MISMATCH");
});

test("draft snapshots surface unresolved references with diagnostics, never as resolved facts", () => {
  const m = model();
  m.project.status = "draft";
  m.modules[1]!.dependsOn = [{ unresolved: "Identity" }];
  const q = api(m);
  const r = q.getContext({ id: "mod-notifications", direction: "outgoing" });
  assert.ok(r.ok);
  assert.equal(r.context.snapshotStatus, "draft");
  assert.ok(
    r.data.edges.some((e) => e.relation === "dependsOn" && typeof e.to !== "string" && e.to.unresolved === "Identity"),
  );
  assert.deepEqual(
    r.diagnostics.map((d) => d.code),
    ["UNRESOLVED_REF"],
  );
  assert.deepEqual(data(q.getProjectOverview()).validation, { errors: 0, warnings: 1 });
});

test("queries never change the model, its revision or anything on disk", () => {
  const dir = join(tempDir("vcv-query-"), "store");
  FileStore.init(dir, model());
  const fingerprint = () =>
    walk(dir)
      .map((f) => `${f}:${statSync(f).mtimeMs}:${createHash("sha256").update(readFileSync(f)).digest("hex")}`)
      .join("\n");
  const store = new FileStore(dir);
  const before = fingerprint();
  const snapshot = store.current();

  const q = createQueryApi(store);
  q.getProjectOverview();
  q.searchObjects({ text: "enrollment notifications" });
  const ctx = data(q.getContext({ id: "beh-enrollment-approval", depth: 2 }));
  (ctx.focus.record as { name: string }).name = "mutated by caller"; // callers get copies
  q.analyzeImpact({ ids: ["evt-enrollment-rejected", "st-pending"] });

  assert.equal(fingerprint(), before);
  assert.deepEqual(store.current(), snapshot);
  assert.deepEqual(store.revisions(), ["rev-1"]);
});

function walk(d: string): string[] {
  return readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
    .sort();
}

test("a search cursor only continues the search that issued it", () => {
  const q = api();
  const first = data(q.searchObjects({ text: "enrollment", limit: 3 }));
  const cursor = first.nextCursor!;

  // Same terms in another order / case / spacing normalize to the same search.
  const same = q.searchObjects({ text: "  ENROLLMENT ", limit: 3, cursor });
  assert.ok(same.ok, "normalized-equal search accepts the cursor");

  for (const other of [
    { text: "rejection", cursor },
    { text: "enrollment rejection", cursor },
    { text: "enrollment", kinds: ["event" as const], cursor },
  ]) {
    const r = q.searchObjects(other);
    assert.ok(!r.ok, `cursor reused by ${JSON.stringify(other)} must be refused`);
    assert.equal(r.error.code, "INVALID_CURSOR");
  }

  // A tampered offset (past the end) is refused rather than returning an empty page.
  const [rev, scope] = cursor.split(":");
  for (const offset of ["9999", "-1", "01", "1.5"]) {
    const r = q.searchObjects({ text: "enrollment", limit: 3, cursor: `${rev}:${scope}:${offset}` });
    assert.ok(!r.ok && r.error.code === "INVALID_CURSOR", `offset ${offset} refused`);
  }
  // A search cursor is not an overview cursor either.
  const o = q.getProjectOverview({ cursor });
  assert.ok(!o.ok && o.error.code === "INVALID_CURSOR");
});

test("the complete edge set between returned nodes is included", () => {
  const c = data(api().getContext({ id: "evt-enrollment-rejected", depth: 2 }));
  const has = (from: string, relation: string, to: string) =>
    c.edges.some((e) => e.from === from && e.relation === relation && e.to === to);
  assert.ok(ids(c.nodes).includes("beh-rejection-notice") && ids(c.nodes).includes("mod-notifications"));
  assert.ok(has("beh-rejection-notice", "owner", "mod-notifications"), "edge between two non-focus nodes is returned");
  const inSet = new Set([c.focus.id, ...ids(c.nodes)]);
  for (const e of c.edges) {
    assert.ok(inSet.has(e.from), `edge source ${e.from} is a returned node`);
    assert.ok(typeof e.to !== "string" || inSet.has(e.to), `edge target ${String(e.to)} is a returned node`);
  }
  assert.equal(c.edgesTotal, c.edges.length);

  // Relation filters still apply to the complete set.
  const f = data(
    api().getContext({ id: "evt-enrollment-rejected", depth: 2, relations: ["contractPublishes", "consumes"] }),
  );
  assert.ok(f.edges.every((e) => e.relation === "contractPublishes" || e.relation === "consumes"));
});

/** A model far larger than the fixture: many modules, a huge behavior and a wide data object. */
function largeModel(): Model {
  const m = structuredClone(model());
  for (let i = 0; i < 300; i++) {
    const id = `mod-bulk-${String(i).padStart(3, "0")}`;
    m.modules.push({
      id,
      owner: "prj-lms",
      kind: "module",
      name: `Bulk ${i}`,
      purpose: "Generated",
      dependsOn: ["mod-enrollment"],
    });
  }
  m.data.push({
    id: "data-wide",
    owner: "mod-enrollment",
    kind: "data",
    name: "Wide",
    attributes: Array.from({ length: 1000 }, (_, i) => ({ id: `attr-wide-${i}`, name: `Field ${i}`, type: "string" })),
  });
  const states = Array.from({ length: 1200 }, (_, i) => ({ id: `st-big-${i}`, name: `S${i}` }));
  m.behaviors.push({
    id: "beh-big",
    owner: "mod-enrollment",
    kind: "behavior",
    name: "Big",
    initialStateId: "st-big-0",
    states,
    transitions: states.slice(1).map((s, i) => ({
      id: `tr-big-${i}`,
      fromStateId: `st-big-${i}`,
      toStateId: s.id,
      trigger: { kind: "event", eventId: "evt-approval-submitted" },
    })),
  });
  return m;
}

test("responses stay bounded on a large model", () => {
  const q = api(largeModel());
  const size = (x: unknown) => JSON.stringify(x).length;

  // Overview pages modules and caps per-module lists; walking the cursor visits every module once.
  const o1 = data(q.getProjectOverview());
  assert.equal(o1.modules.length, 50);
  assert.equal(o1.modulesTotal, 302);
  assert.equal(o1.truncated, true);
  const seen = new Set(ids(o1.modules));
  for (let cur = o1.nextCursor; cur; ) {
    const p = data(q.getProjectOverview({ moduleLimit: 200, cursor: cur }));
    assert.ok(p.modules.length <= 200);
    ids(p.modules).forEach((id) => seen.add(id));
    cur = p.nextCursor;
  }
  assert.equal(seen.size, 302);
  const enr = o1.modules.find((x) => x.id === "mod-enrollment");
  assert.ok(!enr || enr.dependsOn.length <= 25);
  assert.ok(size(o1) < 64_000, `overview page is ${size(o1)} bytes`);
  assert.ok(!q.getProjectOverview({ moduleLimit: 201 }).ok, "module page size is capped");

  // The focus record is a bounded detail view with explicit truncation markers.
  const beh = data(q.getContext({ id: "beh-big" }));
  const rec = beh.focus.record as { states: unknown[]; transitions: unknown[] };
  assert.equal(rec.states.length, 25);
  assert.deepEqual(
    beh.focus.truncatedFields?.find((t) => t.field === "states"),
    { field: "states", returned: 25, total: 1200 },
  );
  assert.deepEqual(
    beh.focus.truncatedFields?.find((t) => t.field === "transitions"),
    { field: "transitions", returned: 25, total: 1199 },
  );
  assert.equal(beh.truncated, true);
  assert.ok(beh.nodes.length <= 25 && beh.edges.length <= 100);
  assert.ok(size(beh) < 64_000, `context is ${size(beh)} bytes`);

  const wide = data(q.getContext({ id: "data-wide", maxNestedItems: 200 }));
  assert.equal((wide.focus.record as { attributes: unknown[] }).attributes.length, 200);
  assert.deepEqual(wide.focus.truncatedFields, [{ field: "attributes", returned: 200, total: 1000 }]);

  // A module with 300 dependents: nodes and edges are capped and the totals are reported.
  const hub = data(q.getContext({ id: "mod-enrollment", maxNodes: 200, maxEdges: 50 }));
  assert.ok(hub.nodes.length <= 200);
  assert.equal(hub.edges.length, 50);
  assert.ok(hub.edgesTotal > 50);
  assert.equal(hub.truncated, true);

  // Search and impact stay within their limits too.
  const s = data(q.searchObjects({ text: "bulk", limit: 100 }));
  assert.equal(s.hits.length, 100);
  assert.ok(s.total >= 300 && s.truncated);
  const imp = data(q.analyzeImpact({ ids: ["mod-enrollment"] }));
  assert.ok(imp.candidates.length <= 50 && imp.truncated);
});
