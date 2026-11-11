// End-to-end tests for the MCP adapter: each test starts the real stdio server as a child
// process on a temporary Enrollment store and talks to it with the official MCP client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadModel, parseYaml } from "../../../packages/ir/src/index.ts";
import type { Model } from "../../../packages/ir/src/index.ts";
import { FileStore, ModelEngine } from "../../../packages/core/src/index.ts";
import { contextRequest, impactRequest, overviewRequest, searchRequest } from "../../../packages/query/src/index.ts";
import type { ImpactAnalysis, ObjectContext, ProjectOverview, QueryResult, SearchResults } from "../../../packages/query/src/index.ts";

const ROOT = join(import.meta.dirname, "../../..");
const MAIN = join(ROOT, "apps/mcp/src/main.ts");
const FIXTURES = join(ROOT, "examples/enrollment");
const TOOLS = ["vcv_analyze_impact", "vcv_get_context", "vcv_get_project_overview", "vcv_search_objects"];

function newStore(edit?: (m: Model) => void): string {
  const dir = join(mkdtempSync(join(tmpdir(), "vcv-mcp-")), "store");
  const model = loadModel(readFileSync(join(FIXTURES, "model.rev-1.yaml"), "utf8")).model!;
  edit?.(model);
  FileStore.init(dir, model);
  return dir;
}

/** Start the server on `store` and connect an MCP client to it; collects the server's stderr. */
async function connect(store: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", MAIN, "--store", store],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr!.on("data", (b: Buffer) => (stderr += b.toString()));
  const client = new Client({ name: "vcv-integration-test", version: "0" });
  await client.connect(transport);
  /** Call a tool and return its structured QueryResult (asserting the text block says the same). */
  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<QueryResult<T>> {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const structured = r.structuredContent as QueryResult<T>;
    assert.equal(r.isError, !structured.ok, "isError mirrors ok");
    const text = r.content[0];
    assert.ok(text?.type === "text");
    assert.deepEqual(JSON.parse(text.text), structured, "text content carries the same result");
    return structured;
  }
  return { client, call, stderr: () => stderr, close: () => client.close() };
}

function data<T>(r: QueryResult<T>): T {
  assert.ok(r.ok, `query failed: ${JSON.stringify(!r.ok && r.error)}`);
  return r.data;
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

function fingerprint(dir: string): string {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [join(d, e.name) + "/", ...walk(join(d, e.name))] : [join(d, e.name)])).sort();
  return walk(dir)
    .map((f) => (f.endsWith("/") ? f : `${f}:${statSync(f).mtimeMs}:${createHash("sha256").update(readFileSync(f)).digest("hex")}`))
    .join("\n");
}

test("the server advertises the four read-only tools, their query-contract schemas and agent instructions", async () => {
  const s = await connect(newStore());
  try {
    assert.deepEqual(s.client.getServerVersion()?.name, "vcv");
    const instructions = s.client.getInstructions() ?? "";
    assert.match(instructions, /implementationChecked: false/);
    assert.match(instructions, /expectedRevision/);
    assert.match(instructions, /draft or approved/);
    assert.match(instructions, /context\.snapshotStatus/);
    assert.match(instructions, /Do not present a draft as approved intent/);
    assert.match(instructions, /overview[\s\S]*search[\s\S]*context[\s\S]*impact[\s\S]*source and tests/i);

    const { tools } = await s.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
    const schemaOf = (zs: z.ZodType) => {
      const { $schema: _, ...rest } = z.toJSONSchema(zs, { io: "input" }) as Record<string, unknown>;
      return rest;
    };
    const expected: Record<string, unknown> = {
      vcv_get_project_overview: schemaOf(overviewRequest),
      vcv_search_objects: schemaOf(searchRequest),
      vcv_get_context: schemaOf(contextRequest),
      vcv_analyze_impact: schemaOf(impactRequest),
    };
    for (const t of tools) {
      assert.deepEqual(t.inputSchema, expected[t.name], `${t.name} schema comes from @vcv/query`);
      assert.equal(t.annotations?.readOnlyHint, true);
      assert.equal(t.annotations?.destructiveHint, false);
      assert.match(t.description ?? "", /implementationChecked=false/);
      assert.match(t.description ?? "", /expectedRevision/);
      assert.match(t.description ?? "", /draft or approved: see context\.snapshotStatus and diagnostics/);
    }
    assert.match(tools.find((t) => t.name === "vcv_search_objects")!.description!, /bounded/i);
    assert.match(s.stderr(), /serving prj-lms .* \(now at rev-1, read-only\)/);
  } finally {
    await s.close();
  }
});

test("rejected enrollment → Notifications: overview, search, context and impact over MCP", async () => {
  const s = await connect(newStore());
  try {
    // 1. Overview: provenance envelope and module boundaries.
    const overview = await s.call<ProjectOverview>("vcv_get_project_overview");
    assert.deepEqual(overview.ok && overview.context, {
      projectId: "prj-lms",
      modelRevision: "rev-1",
      snapshotStatus: "approved",
      source: "canonical-ir",
      coverage: "model-only",
      implementationChecked: false,
    });
    const o = data(overview);
    const notif = o.modules.find((m) => m.id === "mod-notifications")!;
    assert.deepEqual(notif.dependsOn, ["mod-enrollment"]);
    assert.deepEqual(notif.consumes, ["ctr-enrollment-events"]);
    assert.ok(o.modules.find((m) => m.id === "mod-enrollment")!.exposes.includes("ctr-enrollment-events"));
    const rev = overview.ok ? overview.context.modelRevision : "";

    // 2. Search, pinned to the revision, bounded and paged.
    const first = data(await s.call<SearchResults>("vcv_search_objects", { text: "rejected enrollment", limit: 3, expectedRevision: rev }));
    assert.equal(first.hits.length, 3);
    assert.ok(first.total > 3 && first.truncated && first.nextCursor);
    const hitIds = ids(first.hits);
    const second = data(await s.call<SearchResults>("vcv_search_objects", { text: "rejected enrollment", limit: 3, cursor: first.nextCursor, expectedRevision: rev }));
    assert.ok(ids(second.hits).every((id) => !hitIds.includes(id)), "next page continues, no repeats");
    const all = data(await s.call<SearchResults>("vcv_search_objects", { text: "rejected enrollment", limit: 100 }));
    assert.ok(ids(all.hits).includes("evt-enrollment-rejected"));
    assert.equal(all.hits.find((h) => h.id === "evt-enrollment-rejected")!.moduleId, "mod-enrollment");

    // 3. Context of the event: contract and event path from Enrollment to Notifications.
    const ctx = data(await s.call<ObjectContext>("vcv_get_context", { id: "evt-enrollment-rejected", depth: 2, expectedRevision: rev }));
    const edge = (from: string, relation: string, to: string) => ctx.edges.some((e) => e.from === from && e.relation === relation && e.to === to);
    assert.equal(ctx.focus.moduleId, "mod-enrollment");
    assert.ok(edge("tr-reject", "effectEvent", "evt-enrollment-rejected"), "Enrollment's reject transition emits it");
    assert.ok(edge("ctr-enrollment-events", "contractPublishes", "evt-enrollment-rejected"), "published by the Enrollment events contract");
    assert.ok(edge("mod-notifications", "consumes", "ctr-enrollment-events"), "Notifications consumes that contract");
    assert.ok(edge("tr-send-notice", "triggerEvent", "evt-enrollment-rejected"), "Notifications' behavior is triggered by it");
    assert.equal(ctx.edges.find((e) => e.relation === "consumes")!.declaredAt, "modules[1].consumes[0]");

    // 4. Impact: Notifications is a dependent candidate, with path and reason.
    const imp = data(await s.call<ImpactAnalysis>("vcv_analyze_impact", { ids: ["evt-enrollment-rejected"], expectedRevision: rev }));
    assert.equal(imp.impactClass, "structural-candidate");
    assert.match(imp.note, /not.*checked/i);
    const cand = imp.candidates.find((c) => c.id === "mod-notifications")!;
    assert.equal(cand.via, "dependent");
    assert.deepEqual(cand.dependencyPath, [
      { from: "evt-enrollment-rejected", relation: "contractPublishes", to: "ctr-enrollment-events" },
      { from: "ctr-enrollment-events", relation: "consumes", to: "mod-notifications" },
    ]);
    assert.match(cand.reason, /module mod-notifications references contract ctr-enrollment-events \(consumes this contract\)/);

    // Budgets are enforced by the query package and reported.
    const small = data(await s.call<ImpactAnalysis>("vcv_analyze_impact", { ids: ["evt-enrollment-rejected"], maxResults: 2 }));
    assert.equal(small.candidates.length, 2);
    assert.equal(small.truncated, true);
    const cut = data(await s.call<ObjectContext>("vcv_get_context", { id: "mod-enrollment", maxNodes: 3 }));
    assert.equal(cut.nodes.length, 3);
    assert.equal(cut.truncated, true);
  } finally {
    await s.close();
  }
});

test("bad queries return structured tool errors and the server keeps serving", async () => {
  const s = await connect(newStore());
  try {
    const unknown = await s.call("vcv_get_context", { id: "evt-nope" });
    assert.ok(!unknown.ok);
    assert.equal(unknown.error.code, "UNKNOWN_ID");
    assert.equal(unknown.context?.modelRevision, "rev-1");

    const unknownSeed = await s.call("vcv_analyze_impact", { ids: ["evt-enrollment-rejected", "mod-ghost"] });
    assert.ok(!unknownSeed.ok && unknownSeed.error.code === "UNKNOWN_ID" && /mod-ghost/.test(unknownSeed.error.message));

    const tooDeep = await s.call("vcv_get_context", { id: "mod-enrollment", depth: 9, colour: "red" });
    assert.ok(!tooDeep.ok && tooDeep.error.code === "INVALID_REQUEST");
    assert.deepEqual(tooDeep.error.details?.map((d) => d.path).sort(), ["", "depth"], "range and unknown-key problems are both listed");

    const missing = await s.call("vcv_search_objects", {});
    assert.ok(!missing.ok && missing.error.code === "INVALID_REQUEST" && missing.error.details?.[0]?.path === "text");

    const badCursor = await s.call("vcv_search_objects", { text: "enrollment", cursor: "not-a-cursor" });
    assert.ok(!badCursor.ok && badCursor.error.code === "INVALID_CURSOR");

    const stale = await s.call("vcv_get_project_overview", { expectedRevision: "rev-0" });
    assert.ok(!stale.ok && stale.error.code === "REVISION_MISMATCH");

    const r = (await s.client.callTool({ name: "vcv_write_model", arguments: {} })) as CallToolResult;
    assert.equal(r.isError, true);
    const err = r.structuredContent as { ok: false; error: { code: string; message: string } };
    assert.equal(err.error.code, "INVALID_REQUEST");
    assert.match(err.error.message, /unknown tool "vcv_write_model"; available: vcv_get_project_overview/);

    // Still alive and answering normally after all of that.
    assert.ok((await s.call("vcv_get_project_overview")).ok);
  } finally {
    await s.close();
  }
});

test("a draft store is served as a draft, with unresolved references as diagnostics, not resolved facts", async () => {
  const s = await connect(
    newStore((m) => {
      m.project.status = "draft";
      m.modules[1]!.dependsOn = [{ unresolved: "Identity" }];
    }),
  );
  try {
    const overview = await s.call<ProjectOverview>("vcv_get_project_overview");
    assert.ok(overview.ok);
    assert.equal(overview.context.snapshotStatus, "draft");
    assert.deepEqual(overview.data.validation, { errors: 0, warnings: 1 });
    assert.deepEqual(overview.data.modules.find((m) => m.id === "mod-notifications")!.dependsOn, [{ unresolved: "Identity" }]);

    const ctx = await s.call<ObjectContext>("vcv_get_context", { id: "mod-notifications", direction: "outgoing" });
    assert.ok(ctx.ok);
    assert.equal(ctx.context.snapshotStatus, "draft");
    assert.ok(ctx.data.edges.some((e) => e.relation === "dependsOn" && typeof e.to !== "string" && e.to.unresolved === "Identity"));
    assert.ok(!ctx.data.nodes.some((n) => n.id === "Identity"), "an unresolved name is never a node");
    assert.deepEqual(ctx.diagnostics.map((d) => d.code), ["UNRESOLVED_REF"]);
  } finally {
    await s.close();
  }
});

test("a store that becomes unreadable mid-session gives STORE_ERROR and the server recovers when it is fixed", async () => {
  const dir = newStore();
  const s = await connect(dir);
  try {
    const head = readFileSync(join(dir, "HEAD"), "utf8");
    writeFileSync(join(dir, "HEAD"), "{ torn");
    const broken = await s.call("vcv_get_project_overview");
    assert.ok(!broken.ok);
    assert.equal(broken.error.code, "STORE_ERROR");
    assert.match(broken.error.message, /HEAD is unreadable/);
    assert.match(s.stderr(), /vcv_get_project_overview failed: HEAD is unreadable/);

    writeFileSync(join(dir, "HEAD"), head);
    assert.ok((await s.call("vcv_get_project_overview")).ok, "still serving once the store is readable again");
  } finally {
    await s.close();
  }
});

test("queries never write to the store; a revision committed elsewhere is seen on the next call", async () => {
  const dir = newStore();
  const before = fingerprint(dir);
  const s = await connect(dir);
  try {
    await s.call("vcv_get_project_overview");
    await s.call("vcv_search_objects", { text: "enrollment notifications" });
    await s.call("vcv_get_context", { id: "beh-enrollment-approval", depth: 2 });
    await s.call("vcv_analyze_impact", { ids: ["evt-enrollment-rejected", "st-pending"] });
    await s.call("vcv_get_context", { id: "nope" });
    assert.equal(fingerprint(dir), before, "opening and querying the store changed nothing on disk");
    assert.deepEqual(new FileStore(dir).revisions(), ["rev-1"]);

    // Another process (here: this test, as the CLI would) applies a change through the engine.
    const change = parseYaml(readFileSync(join(FIXTURES, "change.timeout.yaml"), "utf8"));
    const outcome = new ModelEngine(new FileStore(dir)).propose(change, { principalId: "user:hoang", permissions: ["model:propose", "model:apply"] });
    assert.equal(outcome.status, "applied");
    const next = outcome.record!.resultingRevision!;

    // The running server notices: pinned calls fail, fresh calls see the new revision.
    const pinned = await s.call("vcv_get_context", { id: "tr-reject", expectedRevision: "rev-1" });
    assert.ok(!pinned.ok && pinned.error.code === "REVISION_MISMATCH");
    assert.equal(pinned.context?.modelRevision, next);
    const ctx = data(await s.call<ObjectContext>("vcv_get_context", { id: "tr-timeout", expectedRevision: next }));
    assert.equal(ctx.focus.kind, "transition");
  } finally {
    await s.close();
  }
});

test("the server refuses to start without an explicit, initialized store and keeps stdout clean", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--experimental-strip-types", MAIN, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env }, input: "" });

  const none = run([]);
  assert.equal(none.status, 2);
  assert.equal(none.stdout, "");
  assert.match(none.stderr, /no model store given: pass --store <store-dir> or set VCV_STORE/);

  const empty = mkdtempSync(join(tmpdir(), "vcv-mcp-empty-"));
  const uninit = run(["--store", empty]);
  assert.equal(uninit.status, 2);
  assert.equal(uninit.stdout, "");
  assert.match(uninit.stderr, /cannot open model store .*not an initialized model store/);
  assert.deepEqual(readdirSync(empty), [], "nothing was created in the directory");

  const bad = run(["--store", empty, "--watch"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown option '--watch'/);

  // VCV_STORE is the config-file equivalent of --store.
  const viaEnv = run([], { VCV_STORE: newStore() });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.equal(viaEnv.stdout, "", "no output on stdout besides JSON-RPC (none was requested)");
});
