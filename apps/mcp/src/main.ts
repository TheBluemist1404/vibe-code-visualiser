#!/usr/bin/env node
// vcv-mcp: a local stdio MCP server exposing VCV's read-only semantic queries for ONE model store.
//
//   node apps/mcp/src/main.ts --store <store-dir>      (or set VCV_STORE=<store-dir>)
//
// The store is always named explicitly; there is no discovery of stores in the working
// directory or repository. stdout carries JSON-RPC only; every diagnostic goes to stderr.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileStoreReader } from "../../../packages/core/src/index.ts";
import { createQueryApi } from "../../../packages/query/src/index.ts";
import { SERVER_VERSION, createVcvMcpServer } from "./server.ts";

const USAGE = `usage: vcv-mcp --store <store-dir>

Serves VCV's read-only model queries over MCP (stdio) for one local model store.
The store is created with: npm run vcv -- init <store-dir> <model.yaml>

  --store <dir>   model store to serve (required; or set VCV_STORE)
  --help          show this help`;

const log = (m: string) => process.stderr.write(`vcv-mcp: ${m}\n`);

function fail(message: string): never {
  log(message);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

let values: { store?: string | undefined; help?: boolean | undefined };
try {
  ({ values } = parseArgs({ options: { store: { type: "string" }, help: { type: "boolean" } }, allowPositionals: false, strict: true }));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
if (values.help) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(0);
}

const storeArg = values.store ?? process.env.VCV_STORE;
if (!storeArg) fail("no model store given: pass --store <store-dir> or set VCV_STORE");
const storeDir = resolve(storeArg);

let reader: FileStoreReader;
try {
  // Read-only: opening does not run recovery or write anything (see FileStoreReader).
  reader = new FileStoreReader(storeDir);
} catch (err) {
  fail(`cannot open model store ${storeDir}: ${err instanceof Error ? err.message : String(err)}`);
}

const head = reader.current().project;
const server = createVcvMcpServer(createQueryApi(reader), { log });
await server.connect(new StdioServerTransport());
log(`v${SERVER_VERSION} serving ${head.id} from ${storeDir} (now at ${head.modelRevision}, read-only)`);

const shutdown = () => void server.close().finally(() => process.exit(0));
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
