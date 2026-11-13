// CLI / MCP parity for the read-only proposal tools (Issue #17, M3.1), and the CLI's
// proposal-only submit as an agent wrapper would run it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listProposalsRequest, previewProposalRequest } from "../../../packages/repo/src/index.ts";
import { ROOT, baseline } from "../../../packages/repo/test/course-desk.ts";

const MAIN = join(ROOT, "apps/mcp/src/main.ts");
const CLI = join(ROOT, "apps/cli/src/main.ts");
const vcv = (env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

const change = {
  changeId: "chg-cancel-enrollment",
  projectId: "prj-course-desk",
  expectedRevision: "rev-1",
  rationale: "A student can cancel a confirmed enrollment and is notified.",
  operations: [
    {
      type: "createCapability",
      capability: {
        id: "cap-cancel-enrollment",
        kind: "capability",
        owner: "mod-enrollment",
        name: "Cancel an enrollment",
        initiatorActorId: "act-student",
      },
    },
    {
      type: "setDescription",
      objectId: "dat-notification",
      description: "kind is enrollment-confirmed|enrollment-rejected|enrollment-cancelled.",
    },
  ],
};

test("vcv proposal submit under a host-fixed agent identity records a pending change only; the agent cannot widen itself or approve", () => {
  const repo = baseline();
  const file = join(repo, "..", "change.yaml");
  writeFileSync(file, JSON.stringify(change));
  const head = readFileSync(join(repo, ".vcv/HEAD"), "utf8");
  const host = { VCV_HOST_PRINCIPAL: "agent:coder", VCV_HOST_PERMISSIONS: "model:propose" };

  const widened = vcv(host, "proposal", "submit", repo, file, "--perm", "propose,apply,approve");
  assert.equal(widened.status, 2);
  assert.match(widened.stderr, /fixed by this host/);

  const r = vcv(host, "proposal", "submit", repo, file);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /chg-cancel-enrollment: pending \(recorded\); \.vcv\/HEAD stays at rev-1/);
  assert.match(r.stdout, /separate reviewer must approve/);
  assert.equal(readFileSync(join(repo, ".vcv/HEAD"), "utf8"), head);

  // Even the default local identity (which holds apply and approve) only proposes on this surface.
  writeFileSync(file, JSON.stringify({ ...change, changeId: "chg-local" }));
  const local = vcv({}, "proposal", "submit", repo, file, "--json");
  assert.equal(JSON.parse(local.stdout).data.status, "pending");
  assert.equal(readFileSync(join(repo, ".vcv/HEAD"), "utf8"), head);

  const approve = vcv(host, "approve", join(repo, ".vcv"), "chg-cancel-enrollment");
  assert.equal(approve.status, 1);
  assert.match(approve.stdout, /denied/);

  const text = vcv(host, "proposal", "preview", repo, "chg-cancel-enrollment");
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /proposal chg-cancel-enrollment \(pending, proposed by agent:coder\)/);
  assert.match(text.stdout, /approval none; snapshot draft; implementation not-recorded/);
  assert.match(text.stdout, /\+ capability cap-cancel-enrollment \[mod-enrollment\]/);
  assert.match(text.stdout, /CROSS-MODULE/);
  assert.match(text.stdout, /not verified by anyone yet:/);

  const list = vcv(host, "proposal", "list", repo);
  assert.match(list.stdout, /chg-cancel-enrollment {2}pending {2}by agent:coder {2}base rev-1/);
  const bad = vcv(host, "proposal", "submit", repo, join(repo, "nope.yaml"));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /✗ INPUT: cannot read/);
});

test("MCP repository mode serves vcv_list_proposals and vcv_preview_proposal read-only, with the same results as the CLI", async () => {
  const repo = baseline();
  const file = join(repo, "..", "change.json");
  writeFileSync(file, JSON.stringify(change));
  assert.equal(
    vcv({ VCV_HOST_PRINCIPAL: "agent:coder", VCV_HOST_PERMISSIONS: "model:propose" }, "proposal", "submit", repo, file)
      .status,
    0,
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", MAIN, "--repo", repo],
    stderr: "pipe",
  });
  const client = new Client({ name: "vcv-proposal-parity", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const strip = (x: z.ZodType) => {
      const { $schema: _d, ...json } = z.toJSONSchema(x, { io: "input" }) as Record<string, unknown>;
      return json;
    };
    const tool = (n: string) => tools.find((t) => t.name === n)!;
    assert.deepEqual(tool("vcv_list_proposals").inputSchema, strip(listProposalsRequest));
    assert.deepEqual(tool("vcv_preview_proposal").inputSchema, strip(previewProposalRequest));
    assert.equal(
      tools.some((t) => /submit|approve|apply/.test(t.name)),
      false,
      "no write tool over MCP",
    );
    assert.match(client.getInstructions() ?? "", /Submitting is not offered over MCP/);
    const call = async (name: string, args: unknown) => {
      const r = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as CallToolResult;
      assert.equal(r.isError, !(r.structuredContent as { ok: boolean }).ok);
      return r.structuredContent;
    };
    const cliJson = (...args: string[]) => JSON.parse(vcv({}, "proposal", ...args, "--json").stdout);
    assert.deepEqual(
      await call("vcv_preview_proposal", { changeId: "chg-cancel-enrollment" }),
      cliJson("preview", repo, "chg-cancel-enrollment"),
    );
    assert.deepEqual(
      await call("vcv_preview_proposal", { change: { ...change, changeId: "chg-dry" } }),
      (writeFileSync(file, JSON.stringify({ ...change, changeId: "chg-dry" })),
      cliJson("preview", repo, "--file", file)),
    );
    assert.deepEqual(await call("vcv_list_proposals", {}), cliJson("list", repo));
    const unknown = (await call("vcv_preview_proposal", { changeId: "chg-nope" })) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(unknown.error.code, "UNKNOWN_CHANGE");
    const malformed = (await call("vcv_preview_proposal", { change: { changeId: "x" } })) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(malformed.error.code, "INVALID_REQUEST");
    assert.equal(JSON.parse(readFileSync(join(repo, ".vcv/HEAD"), "utf8")).revision, "rev-1");
  } finally {
    await client.close();
  }
});
