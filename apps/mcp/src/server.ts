// MCP adapter over the read-only Semantic Query API (@vcv/query) and, for a repository
// checkout, the read-only source-evidence API (@vcv/repo evidence.ts).
//
// This file is transport only. Every tool forwards its raw arguments to one query or evidence
// operation and returns that operation's result unchanged. Request validation, limits,
// revision checks, cursors, errors and diagnostics all come from those packages, and the input
// schemas advertised here are generated from their own zod contracts, so the adapter cannot
// drift from them (the CLI's `vcv evidence` calls the same functions). Nothing here knows or
// cares which client is calling.
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
import { EVIDENCE_LIMITS, bindingEvidenceRequest, evidenceOverviewRequest, objectEvidenceRequest, refreshEvidenceRequest } from "../../../packages/repo/src/evidence.ts";
import type { EvidenceApi, EvidenceResult } from "../../../packages/repo/src/evidence.ts";
import { PROPOSAL_LIMITS, listProposalsRequest, previewProposalRequest } from "../../../packages/repo/src/proposals.ts";
import type { ProposalReadApi, ProposalResult } from "../../../packages/repo/src/proposals.ts";

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

/** Shown in addition when the server runs on a repository checkout (--repo). */
export const EVIDENCE_INSTRUCTIONS = `

Source evidence (repository mode): binding claims say that some code implements, exposes, persists or tests a model object. They are made by an agent or a person; VCV only checks that the pointer resolves and whether the code or the model object changed since the claim. Each item keeps four things apart: claim (the claimant's interpretation, provenance and confidence), locator (does it resolve now), freshness (source/model/git, each with a cause) and approval (always approved: false). States: resolved, stale (code or model changed: look again), missing (renamed/moved/deleted), ambiguous, unchecked (outside the supported TypeScript subset), indeterminate (some evidence unknown, not a pass) and invalid (unreadable claim file). "resolved" is not "correct": inspect the code yourself. Every call recomputes against the working tree; vcv_refresh_evidence rechecks all claims and returns an observationToken to compare later. Nothing is inferred, written or proposed. Extra error codes: UNKNOWN_BINDING, PROJECT_NOT_READY, UNSAFE_PATH, STATE_CHANGED (retry).`;

export type Apis = { query: QueryApi; evidence?: EvidenceApi; proposals?: ProposalReadApi };
type ToolDef = { tool: Tool; call: (apis: Apis, args: unknown) => QueryResult<unknown> | EvidenceResult<unknown> | ProposalResult<unknown> };

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
    call: ({ query }, args) => query.getProjectOverview(args as never),
  },
  {
    tool: {
      name: "vcv_search_objects",
      title: "Search VCV model objects",
      description:
        `Find model objects (modules, events, contracts, capabilities, rules, acceptance criteria, data, behaviors, states, transitions, attributes, actors) by words in their ID, name, purpose, description or statement. Ranking is a deterministic keyword heuristic (not semantic search); terms are OR'd. Results are bounded (limit ≤ ${LIMITS.search.max}, default ${LIMITS.search.default}); total and truncated tell you if more exist, and nextCursor pages through them for the same text and kinds. Use the returned IDs with vcv_get_context. ${REVISION} ${IR_ONLY}`,
      inputSchema: inputSchema(searchRequest),
      annotations: { ...annotations, title: "Search VCV model objects" },
    },
    call: ({ query }, args) => query.searchObjects(args as never),
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
    call: ({ query }, args) => query.getContext(args as never),
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
    call: ({ query }, args) => query.analyzeImpact(args as never),
  },
];

const EVIDENCE =
  "Source evidence for binding claims (see the server instructions). Read-only and recomputed now against the working tree; meaning is never verified (context.meaning=\"unverified\") and no claim is approved. context.snapshotStatus is the model's own draft/approved status, unrelated to whether a pointer resolves.";
const PAGED = `Paged: limit ≤ ${EVIDENCE_LIMITS.max} (default ${EVIDENCE_LIMITS.default}); follow nextCursor, which is bound to the request and to the current claim files.`;

const EVIDENCE_TOOLS: ToolDef[] = [
  {
    tool: {
      name: "vcv_get_evidence_overview",
      title: "VCV evidence overview",
      description: `Counts of binding claims by state (resolved, stale, missing, ambiguous, unchecked, indeterminate, invalid) plus disputed, the model objects claims point to that are no longer in the model, and one page of claims (ID, state, object, relation, locator) ordered by binding ID; filter with states. ${PAGED} ${REVISION} ${EVIDENCE}`,
      inputSchema: inputSchema(evidenceOverviewRequest),
      annotations: { ...annotations, title: "VCV evidence overview" },
    },
    call: ({ evidence }, args) => evidence!.getEvidenceOverview(args as never),
  },
  {
    tool: {
      name: "vcv_get_object_evidence",
      title: "VCV evidence for a model object",
      description: `Every binding claim about one model object (by ID), each with its claim (relation, locator, provenance, rationale, confidence, the revision and commit it was made at), locator resolution now, freshness (source, model, git with causes), dispute and approval. Filter with relations (implements, exposes, persists, tests), selectorKinds (file, symbol, route, test) and states. unreadableClaims counts claim files that could not be read and so may be about this object. ${PAGED} ${REVISION} ${EVIDENCE}`,
      inputSchema: inputSchema(objectEvidenceRequest),
      annotations: { ...annotations, title: "VCV evidence for a model object" },
    },
    call: ({ evidence }, args) => evidence!.getObjectEvidence(args as never),
  },
  {
    tool: {
      name: "vcv_get_binding_evidence",
      title: "VCV evidence for one claim",
      description: `One binding claim by binding ID: the claim as stored (with its file digest), the observed snapshot recorded with it, its current resolution and freshness, dispute and approval. UNKNOWN_BINDING if there is no such claim file. ${REVISION} ${EVIDENCE}`,
      inputSchema: inputSchema(bindingEvidenceRequest),
      annotations: { ...annotations, title: "VCV evidence for one claim" },
    },
    call: ({ evidence }, args) => evidence!.getBindingEvidence(args as never),
  },
  {
    tool: {
      name: "vcv_refresh_evidence",
      title: "Recheck VCV evidence now",
      description: `Explicitly recheck every claim (or the given bindingIds) against the current working tree and model, and return counts, one page of states and an observationToken. Pass an earlier token as since to learn whether any reported evidence changed (changedSince). Writes nothing (writes: "none"); there is no background watcher. ${PAGED} ${REVISION} ${EVIDENCE}`,
      inputSchema: inputSchema(refreshEvidenceRequest),
      // Not idempotent in result (the working tree may have changed), but never writes.
      annotations: { ...annotations, idempotentHint: false, title: "Recheck VCV evidence now" },
    },
    call: ({ evidence }, args) => evidence!.refreshEvidence(args as never),
  },
];

/** Shown in addition when the server also serves proposals (--repo). */
export const PROPOSAL_INSTRUCTIONS = `

Model proposals (repository mode, read-only here): a proposal is a typed model change waiting for a separate reviewer. vcv_preview_proposal shows what one changes before anyone approves it (pass changeId for a submitted one, or change for a dry run of your own draft): operations, the object-level before/after delta, structural impact across modules and contracts (crossModule), binding claims on the touched objects, the engine's diagnostics now (each with a hint) and the assumptions nobody has verified. Lifecycles: pending (waiting; .vcv/HEAD unchanged), stale (its base revision is no longer current: submit a new one), rejected, applied, invalid. The model's draft/approved status, a change's approval and implementation are separate things; VCV never infers implementation (an implementing agent's report, recorded with \`vcv implementation record\`, is a separate unverified claim). Submitting is not offered over MCP: use the host's \`vcv proposal submit\` (proposal-only). Nothing here approves, applies or writes. Each call reads the checkout once and rechecks it before answering; STATE_CHANGED means it moved (a checkout or an edit) and nothing was mixed: retry. A change's approval field (none, applied-by-host, approved-by-separate-reviewer) is what the record says, not an authenticated identity. Extra error codes: UNKNOWN_CHANGE, INVALID_RECORD, STATE_CHANGED.`;

const PROPOSAL = "Read-only; writes nothing, approves nothing. Structural impact is not semantic proof, and code is never inspected (context.implementationChecked=false).";

const PROPOSAL_TOOLS: ToolDef[] = [
  {
    tool: {
      name: "vcv_list_proposals",
      title: "VCV model proposals",
      description: `Every model change proposal recorded in this checkout, with its derived lifecycle (pending, stale with reason superseded|other-line, rejected, applied, invalid), proposer, base revision, resulting revision if applied, proposalDigest and operation count; counts by lifecycle. Filter with lifecycles; limit ≤ ${PROPOSAL_LIMITS.list.max} (default ${PROPOSAL_LIMITS.list.default}). ${PROPOSAL}`,
      inputSchema: inputSchema(listProposalsRequest),
      annotations: { ...annotations, title: "VCV model proposals" },
    },
    call: ({ proposals }, args) => proposals!.listProposals(args as never),
  },
  {
    tool: {
      name: "vcv_preview_proposal",
      title: "Preview a VCV model proposal",
      description: `Review one proposal before approval: pass changeId (submitted) or change (the same typed change object submit takes, as a dry run; at most ${PROPOSAL_LIMITS.maxOperations} operations). Returns its operations, proposalDigest, the engine's validation against the current revision now (errors carry hints; a stale proposal shows its delta against its base revision), the object-level before/after delta, impacted modules and contracts with crossModule, structural impact candidates, binding claims on changed/removed/impacted objects, separate change/approval/snapshot/implementation states, and unverified assumptions. Lists are capped by limit ≤ ${PROPOSAL_LIMITS.items.max}. ${PROPOSAL}`,
      inputSchema: inputSchema(previewProposalRequest),
      annotations: { ...annotations, title: "Preview a VCV model proposal" },
    },
    call: ({ proposals }, args) => proposals!.previewProposal(args as never),
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.tool.name);
export const PROPOSAL_TOOL_NAMES = PROPOSAL_TOOLS.map((t) => t.tool.name);
export const EVIDENCE_TOOL_NAMES = EVIDENCE_TOOLS.map((t) => t.tool.name);

export type ServerOptions = {
  /** Where diagnostics go. Never stdout: on stdio transport stdout carries JSON-RPC only. */
  log?: (message: string) => void;
};

/**
 * Build an MCP server whose tools answer from `api` (a QueryApi, or { query, evidence } for a
 * repository checkout, which adds the evidence tools). Connect it to any transport.
 */
export function createVcvMcpServer(api: QueryApi | Apis, opts: ServerOptions = {}): Server {
  const apis: Apis = "query" in api ? api : { query: api };
  const tools = [...TOOLS, ...(apis.evidence ? EVIDENCE_TOOLS : []), ...(apis.proposals ? PROPOSAL_TOOLS : [])];
  const names = tools.map((t) => t.tool.name);
  const log = opts.log ?? ((m: string) => process.stderr.write(`vcv-mcp: ${m}\n`));
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Vibe Code Visualiser (read-only model queries)" },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS + (apis.evidence ? EVIDENCE_INSTRUCTIONS : "") + (apis.proposals ? PROPOSAL_INSTRUCTIONS : ""),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.map((t) => t.tool) }));

  server.setRequestHandler(CallToolRequestSchema, (req): CallToolResult => {
    const def = tools.find((t) => t.tool.name === req.params.name);
    if (!def) {
      // Reported as a tool error, not a protocol error, so the agent can read it and recover.
      return toolResult({ ok: false, error: { code: "INVALID_REQUEST", message: `unknown tool "${req.params.name}"; available: ${names.join(", ")}` } });
    }
    try {
      return toolResult(def.call(apis, req.params.arguments ?? {}));
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

type AdapterResult = QueryResult<unknown> | EvidenceResult<unknown> | ProposalResult<unknown> | { ok: false; error: { code: "INVALID_REQUEST" | "STORE_ERROR"; message: string } };

/** The QueryResult itself is the structured content; the text block carries the same JSON. */
function toolResult(result: AdapterResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
    isError: !result.ok,
  };
}
