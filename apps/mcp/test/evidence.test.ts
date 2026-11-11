// CLI / MCP parity for the read-only source-evidence queries (Issue #15, M2.5): the same request
// gives the same result through `vcv evidence … --request` and the MCP tools, including errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { bindingEvidenceRequest, evidenceOverviewRequest, objectEvidenceRequest, refreshEvidenceRequest } from "../../../packages/repo/src/index.ts";
import { ROOT, SERVICE, baseline, edit } from "../../../packages/repo/test/course-desk.ts";

const MAIN = join(ROOT, "apps/mcp/src/main.ts");
const CLI = join(ROOT, "apps/cli/src/main.ts");
const OPS = {
  overview: "vcv_get_evidence_overview",
  object: "vcv_get_object_evidence",
  binding: "vcv_get_binding_evidence",
  refresh: "vcv_refresh_evidence",
} as const;
type Op = keyof typeof OPS;

function cli(repo: string, op: Op, request: unknown) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, "evidence", repo, op, "--request", JSON.stringify(request)], { encoding: "utf8" });
  return { status: r.status, result: JSON.parse(r.stdout) as { ok: boolean; error?: { code: string } } };
}

async function connect(repo: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--experimental-strip-types", MAIN, "--repo", repo], stderr: "pipe" });
  const client = new Client({ name: "vcv-evidence-parity", version: "0" });
  await client.connect(transport);
  return {
    client,
    async call(name: string, args: unknown) {
      const r = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as CallToolResult;
      const structured = r.structuredContent as { ok: boolean };
      assert.equal(r.isError, !structured.ok);
      assert.deepEqual(JSON.parse((r.content[0] as { text: string }).text), structured);
      return structured;
    },
    close: () => client.close(),
  };
}

const CASES: [Op, unknown][] = [
  ["overview", {}],
  ["overview", { limit: 2 }],
  ["overview", { states: ["stale", "missing"] }],
  ["object", { id: "cap-enroll" }],
  ["object", { id: "rul-seat-limit", relations: ["tests"] }],
  ["object", { id: "cap-enroll", selectorKinds: ["route"], expectedRevision: "rev-1" }],
  ["binding", { bindingId: "impl.cap-enroll" }],
  ["refresh", {}],
  ["refresh", { bindingIds: ["test.rul-seat-limit"] }],
  // Errors
  ["object", { id: "cap-nope" }],
  ["object", {}],
  ["object", { id: "cap-enroll", limit: 0, extra: true }],
  ["object", { id: 42 }],
  ["binding", { bindingId: "impl.nope" }],
  ["binding", { bindingId: "../../etc/passwd" }],
  ["overview", { expectedRevision: "rev-9" }],
  ["overview", { cursor: "rev-1:0000000000000000:1" }],
  ["refresh", { since: "zz" }],
];

test("repository mode adds four evidence tools (and the read-only proposal tools) whose schemas are the shared request contracts; store mode is unchanged", async () => {
  const repo = baseline();
  const s = await connect(repo);
  try {
    const { tools } = await s.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "vcv_analyze_impact", "vcv_get_binding_evidence", "vcv_get_context", "vcv_get_evidence_overview",
      "vcv_get_object_evidence", "vcv_get_project_overview", "vcv_list_proposals", "vcv_preview_proposal",
      "vcv_refresh_evidence", "vcv_search_objects",
    ]);
    const schema = (n: string) => tools.find((t) => t.name === n)!.inputSchema;
    const strip = (x: z.ZodType) => {
      const { $schema: _d, ...json } = z.toJSONSchema(x, { io: "input" }) as Record<string, unknown>;
      return json;
    };
    assert.deepEqual(schema(OPS.overview), strip(evidenceOverviewRequest));
    assert.deepEqual(schema(OPS.object), strip(objectEvidenceRequest));
    assert.deepEqual(schema(OPS.binding), strip(bindingEvidenceRequest));
    assert.deepEqual(schema(OPS.refresh), strip(refreshEvidenceRequest));
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
    const instructions = s.client.getInstructions() ?? "";
    assert.match(instructions, /approved: false/);
    assert.match(instructions, /"resolved" is not "correct"/);
    // The model tools answer from the checkout's .vcv/.
    const ov = (await s.call("vcv_get_project_overview", {})) as { ok: boolean; context: { projectId: string } };
    assert.equal(ov.context.projectId, "prj-course-desk");
  } finally {
    await s.close();
  }
});

test("CLI and MCP give identical results for the same requests, valid and malformed, on a dirty working tree", async () => {
  const repo = baseline();
  edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length > course.capacity");
  const s = await connect(repo);
  try {
    for (const [op, req] of CASES) {
      const viaCli = cli(repo, op, req);
      const viaMcp = await s.call(OPS[op], req);
      assert.deepEqual(viaMcp, viaCli.result, `${op} ${JSON.stringify(req)}`);
      assert.equal(viaCli.status, viaCli.result.ok ? 0 : 1);
    }
    // The same object evidence through both: claim ID, provenance, locator and state agree.
    const both = [cli(repo, "object", { id: "rul-seat-limit" }).result, await s.call(OPS.object, { id: "rul-seat-limit" })] as unknown as {
      data: { bindings: { bindingId: string; state: string; claim: { provenance: unknown; locator: { text: string } } }[] };
    }[];
    for (const r of both) assert.deepEqual(r.data.bindings.map((b) => [b.bindingId, b.state]), [["impl.rul-seat-limit", "stale"], ["test.rul-seat-limit", "resolved"]]);
  } finally {
    await s.close();
  }
});

test("parity for conflicted and unsafe claim storage and a project that stops being ready", async () => {
  const repo = baseline();
  const s = await connect(repo);
  try {
    const file = join(repo, ".vcv/bindings/impl.cap-enroll.json");
    writeFileSync(file, `<<<<<<< ours\n${readFileSync(file, "utf8")}=======\n>>>>>>> theirs\n`);
    for (const [op, req] of [["overview", {}], ["binding", { bindingId: "impl.cap-enroll" }], ["object", { id: "cap-enroll" }]] as [Op, unknown][]) {
      const viaCli = cli(repo, op, req).result;
      assert.ok(viaCli.ok);
      assert.deepEqual(await s.call(OPS[op], req), viaCli);
    }
    renameSync(join(repo, ".vcv/bindings"), join(repo, "elsewhere"));
    symlinkSync(join(repo, "elsewhere"), join(repo, ".vcv/bindings"));
    const unsafe = cli(repo, "overview", {}).result;
    assert.equal(unsafe.error?.code, "UNSAFE_PATH");
    assert.deepEqual(await s.call(OPS.overview, {}), unsafe);
    // Model queries still answer while the claims are unreadable.
    assert.equal(((await s.call("vcv_get_context", { id: "cap-enroll" })) as { ok: boolean }).ok, true);

    const head = join(repo, ".vcv/HEAD");
    writeFileSync(head, `<<<<<<< ours\n${readFileSync(head, "utf8")}=======\n>>>>>>> theirs\n`);
    const notReady = cli(repo, "overview", {}).result;
    assert.equal(notReady.error?.code, "PROJECT_NOT_READY");
    assert.deepEqual(await s.call(OPS.overview, {}), notReady);
  } finally {
    await s.close();
  }
  // No project at all: the CLI says so, and the MCP server refuses to start with the same cause.
  const none = realpathSync(mkdtempSync(join(tmpdir(), "vcv-noproj-")));
  assert.equal(cli(none, "overview", {}).result.error?.code, "PROJECT_NOT_READY");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", MAIN, "--repo", none], { encoding: "utf8", input: "" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is absent/);
});
