#!/usr/bin/env node
// vcv-mcp: a local stdio MCP server exposing VCV's read-only semantic queries for ONE model store,
// or for one repository checkout's .vcv/ plus its read-only source evidence.
//
//   node apps/mcp/src/main.ts --store <store-dir>      (or set VCV_STORE=<store-dir>)
//   node apps/mcp/src/main.ts --repo <checkout>        (or set VCV_REPO=<checkout>)
//
// The store or checkout is always named explicitly; there is no discovery in the working
// directory. stdout carries JSON-RPC only; every diagnostic goes to stderr.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileStoreReader } from "../../../packages/core/src/index.ts";
import { createQueryApi } from "../../../packages/query/src/index.ts";
import { createEvidenceApi, createProposalReadApi, projectStatus } from "../../../packages/repo/src/index.ts";
import { SERVER_VERSION, createVcvMcpServer } from "./server.ts";

const USAGE = `usage: vcv-mcp --store <store-dir> | --repo <checkout>

Serves VCV's read-only model queries over MCP (stdio) for one local model store, or for the
.vcv/ project of one repository checkout together with read-only source-evidence tools.
A store is created with: npm run vcv -- init <store-dir> <model.yaml>
A project is created with: npm run vcv -- project init <checkout> <model.yaml>

  --store <dir>   model store to serve (or set VCV_STORE)
  --repo <path>   repository checkout whose .vcv/ to serve, with evidence tools (or set VCV_REPO)
  --help          show this help`;

const log = (m: string) => process.stderr.write(`vcv-mcp: ${m}\n`);

function fail(message: string): never {
  log(message);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

let values: { store?: string | undefined; repo?: string | undefined; help?: boolean | undefined };
try {
  ({ values } = parseArgs({
    options: { store: { type: "string" }, repo: { type: "string" }, help: { type: "boolean" } },
    allowPositionals: false,
    strict: true,
  }));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
if (values.help) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(0);
}

const repoArg = values.repo ?? (values.store ? undefined : process.env.VCV_REPO);
const storeArg = values.store ?? (repoArg ? undefined : process.env.VCV_STORE);
if (repoArg && storeArg) fail("pass either --store or --repo, not both");
if (!storeArg && !repoArg)
  fail("nothing to serve: pass --store <store-dir> or --repo <checkout> (or set VCV_STORE / VCV_REPO)");
let storeDir: string;
if (repoArg) {
  const status = projectStatus(repoArg);
  if (status.state !== "ready")
    fail(
      `the project in ${status.root} is ${status.state}: ${status.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => d.message)
        .join("; ")}`,
    );
  storeDir = status.storeDir;
} else storeDir = resolve(storeArg!);

let reader: FileStoreReader;
try {
  // Read-only: opening does not run recovery or write anything (see FileStoreReader).
  reader = new FileStoreReader(storeDir);
} catch (err) {
  fail(`cannot open model store ${storeDir}: ${err instanceof Error ? err.message : String(err)}`);
}

const head = reader.current().project;
const query = createQueryApi(reader);
const server = createVcvMcpServer(
  repoArg ? { query, evidence: createEvidenceApi(repoArg), proposals: createProposalReadApi(repoArg) } : query,
  { log },
);
await server.connect(new StdioServerTransport());
log(
  `v${SERVER_VERSION} serving ${head.id} from ${storeDir} (now at ${head.modelRevision}, read-only${repoArg ? ", with source evidence" : ""})`,
);

const shutdown = () => void server.close().finally(() => process.exit(0));
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
