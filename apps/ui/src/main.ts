// vcv-ui <checkout> [--port N]: serve the architecture explorer for one checkout on 127.0.0.1.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultStateDir, LayoutFileStore } from "./layout-store.ts";
import { startHost } from "./server.ts";
import { ProjectSession } from "./session.ts";

const USAGE = "usage: npm run ui -- <checkout> [--port N] [--protected-base <ref, e.g. origin/main>]";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string" }, "protected-base": { type: "string" }, help: { type: "boolean", short: "h" } },
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
const host = await startHost({
  session,
  webDir: join(import.meta.dirname, "../dist"),
  port,
  stateDir,
  ...(protectedBase ? { protectedBase } : {}),
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
