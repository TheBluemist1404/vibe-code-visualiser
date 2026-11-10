import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadModel, parseYaml } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import type { HostContext, ProposedModelChange } from "../src/index.ts";

const FIXTURES = join(import.meta.dirname, "../../../examples/enrollment");
export const baseModel = (): Model => loadModel(readFileSync(join(FIXTURES, "model.rev-1.yaml"), "utf8")).model!;
export const timeoutChange = (): ProposedModelChange => parseYaml(readFileSync(join(FIXTURES, "change.timeout.yaml"), "utf8")) as ProposedModelChange;

// Host-supplied identities. In the real product these come from the session, not the payload.
export const owner: HostContext = { principalId: "user:hoang", permissions: ["model:propose", "model:apply", "model:approve"] };
export const reviewer: HostContext = { principalId: "user:reviewer", permissions: ["model:propose", "model:approve"] };
export const mcpAgent: HostContext = { principalId: "agent:mcp-session-1", permissions: ["model:propose"] };
export const viewer: HostContext = { principalId: "user:viewer", permissions: [] };

export const renamePending = (changeId: string, expectedRevision = "rev-1"): ProposedModelChange => ({
  changeId,
  projectId: "prj-lms",
  expectedRevision,
  operations: [{ type: "renameState", behaviorId: "beh-enrollment-approval", stateId: "st-pending", name: "Waiting" }],
});
