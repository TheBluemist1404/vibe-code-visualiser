// vcv: a thin CLI adapter over the engine. It contains no domain logic; it only parses
// arguments, calls @vcv/ir / @vcv/core, and prints results.
//
// The CLI acts as the trusted host for a local single user: identity and permissions come
// from flags here, standing in for what a real session or OAuth token would supply.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadModel, parseYaml, ownershipTree } from "../../../packages/ir/src/index.ts";
import type { Diagnostic, TreeNode } from "../../../packages/ir/src/index.ts";
import { FileStore, ModelEngine } from "../../../packages/core/src/index.ts";
import type { HostContext, Outcome, Permission } from "../../../packages/core/src/index.ts";

const USAGE = `vcv <command> [options]

  validate <model.yaml>                 Check a model file (schema, references, consistency)
  init <store-dir> <model.yaml>         Start a model store from a valid model file
  show <store-dir> [--tree]             Print the current revision (or its ownership tree)
  propose <store-dir> <change.yaml>     Submit a change
  approve <store-dir> <changeId>        Approve a pending change

  --as <principal>      Who is acting (default: local-user)
  --perm <list>         Comma list of propose,apply,approve (default: all three)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { as: { type: "string", default: "local-user" }, perm: { type: "string", default: "propose,apply,approve" }, tree: { type: "boolean", default: false } },
});
const [cmd, a, b] = positionals;
const ctx: HostContext = {
  principalId: values.as!,
  permissions: values.perm!.split(",").filter(Boolean).map((p) => `model:${p.trim()}` as Permission),
};

function printDiagnostics(ds: Diagnostic[]) {
  for (const d of ds) console.log(`  ${d.severity === "error" ? "✗" : "!"} ${d.code} at ${d.path || "(root)"}: ${d.message}`);
}
function printOutcome(o: Outcome) {
  const r = o.record;
  const rev = o.status === "applied" && r?.resultingRevision ? ` → ${r.resultingRevision}` : "";
  const who = r ? ` (proposed by ${r.proposerId}${r.approverId ? `, approved by ${r.approverId}` : ""}; record is ${r.status})` : " (not recorded)";
  console.log(`${o.changeId ?? "(no change id)"}: ${o.status}${rev}${who}`);
  printDiagnostics(o.diagnostics);
  return o.status === "applied" || o.status === "pending" ? 0 : 1;
}
function printTree(n: TreeNode, depth = 0) {
  console.log(`${"  ".repeat(depth)}${n.kind} ${n.id}${n.name !== n.id ? ` "${n.name}"` : ""}`);
  n.children.forEach((c) => printTree(c, depth + 1));
}

function main(): number {
  switch (cmd) {
    case "validate": {
      const r = loadModel(readFileSync(a!, "utf8"));
      console.log(r.ok ? `${a}: valid` : `${a}: invalid`);
      printDiagnostics(r.diagnostics);
      return r.ok ? 0 : 1;
    }
    case "init": {
      const r = loadModel(readFileSync(b!, "utf8"));
      if (!r.ok || !r.model) {
        printDiagnostics(r.diagnostics);
        return 1;
      }
      FileStore.init(a!, r.model);
      console.log(`initialized ${a} at ${r.model.project.modelRevision}`);
      return 0;
    }
    case "show": {
      const m = new FileStore(a!).current();
      if (values.tree) printTree(ownershipTree(m));
      else console.log(`${m.project.name} (${m.project.id}) ${m.project.modelRevision} [${m.project.status}]`);
      return 0;
    }
    case "propose":
      return printOutcome(new ModelEngine(new FileStore(a!)).propose(parseYaml(readFileSync(b!, "utf8")), ctx));
    case "approve":
      return printOutcome(new ModelEngine(new FileStore(a!)).approve(b!, ctx));
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

process.exitCode = main();
