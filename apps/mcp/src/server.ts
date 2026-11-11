// MCP adapter over the read-only Semantic Query API (@vcv/query).
//
// This file is transport only. Every tool forwards its raw arguments to one @vcv/query
// operation and returns that operation's QueryResult unchanged. Request validation, limits,
// revision checks, cursors, errors and diagnostics all come from @vcv/query, and the input
// schemas advertised here are generated from the query package's own zod contracts, so the
// adapter cannot drift from them. Nothing here knows or cares which client is calling.
//
// It uses the SDK's low-level `Server` rather than `McpServer` on purpose: McpServer validates
// arguments itself and answers bad input with its own error format, which would duplicate the
// query package's validation and hide its structured INVALID_REQUEST details.
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { LIMITS, contextRequest, impactRequest, overviewRequest, searchRequest } from "../../../packages/query/src/index.ts";
import type { QueryApi, QueryResult } from "../../../packages/query/src/index.ts";

export const SERVER_NAME = "vcv";
export const SERVER_VERSION = "0.1.0";

/** Shown to every client at initialize; mirrors templates/AGENTS.md in short form. */
export const SERVER_INSTRUCTIONS = `VCV (Vibe Code Visualiser) read-only model queries.

These tools read the project's versioned declared model (the VCV IR, draft or approved): modules, capabilities, data, rules, events, contracts and behaviors, with stable IDs. They describe declared INTENT, not the code. Check context.snapshotStatus on every result: "approved" is agreed intent; "draft" is work in progress that may contain unresolved references (edges whose target is { unresolved: "..." }), reported in diagnostics and in the overview's validation counts. Do not present a draft as approved intent. Every result carries context.implementationChecked: false; nothing has been compared with source code, tests or runtime behavior. Never present a query result as proof that the repository implements it.

Recommended workflow:
1. vcv_get_project_overview: modules, their dependencies and exposed contracts, and the current modelRevision.
2. vcv_search_objects: find objects by words (bounded, ranked, paged by cursor).
3. vcv_get_context: inspect one object by ID and its neighbours (bounded by depth and budgets).
4. vcv_analyze_impact: structural change candidates for one or more IDs, when a change is being considered.
5. Then read the repository's source and tests yourself to verify what the code actually does, and report model and code findings separately.

Pass the modelRevision you started from as expectedRevision on later calls; a REVISION_MISMATCH error means the model changed during your analysis, so start again. Errors come back as { ok: false, error: { code, message, details? } } with code INVALID_REQUEST, UNKNOWN_ID, REVISION_MISMATCH, INVALID_CURSOR or STORE_ERROR. These tools never change the model.`;

const IR_ONLY =
  "Reads the VCV model (declared intent, draft or approved: see context.snapshotStatus and diagnostics) only: the result has context.implementationChecked=false, and the repository's code must be inspected separately before claiming anything about real behavior.";
const REVISION = "Pass expectedRevision (the modelRevision from an earlier result) to detect a model change between calls.";

type ToolDef = { tool: Tool; call: (api: QueryApi, args: unknown) => QueryResult<unknown> };

/** JSON Schema for a tool's input, generated from the query package's request contract. */
function inputSchema(schema: z.ZodType): Tool["inputSchema"] {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json as Tool["inputSchema"];
}

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const TOOLS: ToolDef[] = [
  {
    tool: {
      name: "vcv_get_project_overview",
      title: "VCV project overview",
      description:
        `Start here. Returns the project, one page of modules (purpose, dependsOn, consumed contracts, exposed contracts, owned-object counts), the object inventory, validation counts and the current modelRevision. Module lists are paged (moduleLimit ≤ ${LIMITS.overview.maxModules}, default ${LIMITS.overview.defaultModules}; follow nextCursor) and each module's ID lists are capped at ${LIMITS.overview.listItems} with full sizes in counts. ${REVISION} ${IR_ONLY}`,
      inputSchema: inputSchema(overviewRequest),
      annotations: { ...annotations, title: "VCV project overview" },
    },
    call: (api, args) => api.getProjectOverview(args as never),
  },
  {
    tool: {
      name: "vcv_search_objects",
      title: "Search VCV model objects",
      description:
        `Find model objects (modules, events, contracts, capabilities, rules, data, behaviors, states, transitions, attributes, actors) by words in their ID, name, purpose, description or statement. Ranking is a deterministic keyword heuristic (not semantic search); terms are OR'd. Results are bounded (limit ≤ ${LIMITS.search.max}, default ${LIMITS.search.default}); total and truncated tell you if more exist, and nextCursor pages through them for the same text and kinds. Use the returned IDs with vcv_get_context. ${REVISION} ${IR_ONLY}`,
      inputSchema: inputSchema(searchRequest),
      annotations: { ...annotations, title: "Search VCV model objects" },
    },
    call: (api, args) => api.searchObjects(args as never),
  },
  {
    tool: {
      name: "vcv_get_context",
      title: "VCV object context",
      description:
        `Inspect one model object by ID: its canonical record (nested arrays capped at maxNestedItems, cuts listed in truncatedFields), its neighbours within depth (1-${LIMITS.context.maxDepth}) in the chosen direction, and every declared edge between them with its relation, category (ownership, dependency, contract, behavior, data, permission, traceability) and the IR field that declares it. Bounded by maxNodes and maxEdges; truncated=true means something was cut. Filter with relations to follow e.g. only consumes/contractPublishes. Unknown IDs return UNKNOWN_ID. ${REVISION} ${IR_ONLY}`,
      inputSchema: inputSchema(contextRequest),
      annotations: { ...annotations, title: "VCV object context" },
    },
    call: (api, args) => api.getContext(args as never),
  },
  {
    tool: {
      name: "vcv_analyze_impact",
      title: "VCV structural impact",
      description:
        `List objects that may be affected if the given objects (1-${LIMITS.impact.maxSeeds} IDs) change, following declared model references in reverse up to maxDepth (≤ ${LIMITS.impact.maxDepth}). Each candidate has a distance, via (dependent: references a changed object; container: owns or contains it), one shortest dependency path and a plain-language reason. These are structural candidates from the model only (impactClass "structural-candidate"), not a test or code impact analysis: confirm each one in the repository. Bounded by maxResults. ${REVISION} ${IR_ONLY}`,
      inputSchema: inputSchema(impactRequest),
      annotations: { ...annotations, title: "VCV structural impact" },
    },
    call: (api, args) => api.analyzeImpact(args as never),
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.tool.name);

export type ServerOptions = {
  /** Where diagnostics go. Never stdout: on stdio transport stdout carries JSON-RPC only. */
  log?: (message: string) => void;
};

/** Build an MCP server whose tools answer from `api`. Connect it to any transport. */
export function createVcvMcpServer(api: QueryApi, opts: ServerOptions = {}): Server {
  const log = opts.log ?? ((m: string) => process.stderr.write(`vcv-mcp: ${m}\n`));
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Vibe Code Visualiser (read-only model queries)" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS.map((t) => t.tool) }));

  server.setRequestHandler(CallToolRequestSchema, (req): CallToolResult => {
    const def = TOOLS.find((t) => t.tool.name === req.params.name);
    if (!def) {
      // Reported as a tool error, not a protocol error, so the agent can read it and recover.
      return toolResult({ ok: false, error: { code: "INVALID_REQUEST", message: `unknown tool "${req.params.name}"; available: ${TOOL_NAMES.join(", ")}` } });
    }
    try {
      return toolResult(def.call(api, req.params.arguments ?? {}));
    } catch (err) {
      // Queries do not throw for bad input; a throw means the store itself could not be read
      // (e.g. HEAD or a revision file is corrupt). Report it and keep serving.
      const message = err instanceof Error ? err.message : String(err);
      log(`${req.params.name} failed: ${message}`);
      return toolResult({ ok: false, error: { code: "STORE_ERROR", message: `the model store could not be read: ${message}` } });
    }
  });

  return server;
}

type AdapterResult = QueryResult<unknown> | { ok: false; error: { code: "INVALID_REQUEST" | "STORE_ERROR"; message: string } };

/** The QueryResult itself is the structured content; the text block carries the same JSON. */
function toolResult(result: AdapterResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
    isError: !result.ok,
  };
}
