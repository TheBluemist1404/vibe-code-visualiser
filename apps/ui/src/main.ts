// vcv-ui <checkout> [--port N] [--as <principal>]: serve the architecture explorer for one checkout on 127.0.0.1.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultStateDir, LayoutFileStore } from "./layout-store.ts";
import { startHost } from "./server.ts";
import { ProjectSession } from "./session.ts";

const USAGE = "usage: npm run ui -- <checkout> [--port N] [--as <principal>]";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string" }, as: { type: "string" }, help: { type: "boolean", short: "h" } },
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

const layouts = new LayoutFileStore(defaultStateDir());
const session = new ProjectSession(positionals[0] as string, layouts);
// Proposals are recorded for this principal, with model:propose only. Same default as the CLI.
const proposer = values.as ?? process.env.VCV_HOST_PRINCIPAL ?? "local-user";
const host = await startHost({ session, webDir: join(import.meta.dirname, "../dist"), port, proposer });
const { observation } = session.view();
console.log(`VCV explorer for ${observation.root} (${observation.state})`);
console.log(`open ${host.url}`);
console.log(`edits are submitted as pending proposals by ${proposer}; approval stays \`vcv review approve\``);
console.log(`canvas positions are kept in ${layouts.dir}, never in .vcv/`);
