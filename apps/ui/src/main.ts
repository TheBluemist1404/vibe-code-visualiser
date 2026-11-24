// vcv-ui <checkout> [--port N]: serve the architecture explorer for one checkout on 127.0.0.1.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultStateDir, LayoutFileStore } from "./layout-store.ts";
import { startHost } from "./server.ts";
import { ProjectSession } from "./session.ts";

const USAGE = `usage: npm run ui -- <checkout> [--port N] [--protected-base <ref, e.g. origin/main>]
         [--base-commit <full commit ID of the protected base>] [--run <test-run.json>]... [--policy <policy.json>]`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    "protected-base": { type: "string" },
    "base-commit": { type: "string" },
    run: { type: "string", multiple: true },
    policy: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || positionals.length !== 1) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
const port = values.port ? Number(values.port) : 4870;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid --port ${values.port}\n${USAGE}`);
  process.exit(2);
}

const stateDir = defaultStateDir();
const session = new ProjectSession(positionals[0] as string, new LayoutFileStore(stateDir));
const protectedBase = values["protected-base"];
const baseCommit = values["base-commit"];
if (baseCommit !== undefined && !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) {
  console.error(`--base-commit must be a full commit ID (copied from the hosting service), not a ref name\n${USAGE}`);
  process.exit(2);
}
/** Read a JSON input file once, at start. The host never re-reads or writes it. */
const json = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`cannot read ${file}: ${(e as Error).message}`);
    process.exit(2);
  }
};
const runFiles = values.run ?? [];
const evidence = {
  ...(baseCommit ? { baseCommit } : {}),
  ...(runFiles.length ? { runs: runFiles.map(json) } : {}),
  ...(values.policy ? { policy: json(values.policy) } : {}),
  sources: { runs: runFiles, policy: values.policy ?? null },
};
const host = await startHost({
  session,
  webDir: join(import.meta.dirname, "../dist"),
  port,
  stateDir,
  ...(protectedBase ? { protectedBase } : {}),
  evidence,
});
const { observation } = session.view();
console.log(`VCV explorer for ${observation.root} (${observation.state})`);
console.log(`open ${host.url}`);
console.log(
  protectedBase
    ? `proposal integrity is checked against ${protectedBase} (a local ref: caller-asserted; CI is the authority)`
    : "proposal integrity: unknown here (no --protected-base); CI's vcv integrity is the authority",
);
console.log(`canvas positions and local drafts are kept in ${stateDir}, never in the checkout or .vcv/`);
