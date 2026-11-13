// vcv: a thin CLI adapter over the engine. It contains no domain logic; it only parses
// arguments, calls @vcv/ir, @vcv/core, @vcv/query and @vcv/repo, and prints results.
import { loadModel, parseYaml, ownershipTree } from "@vcv/ir";
import { FileStore, ModelEngine, StoreError } from "@vcv/core";
import { createQueryApi } from "@vcv/query";
import { ApprovalError, GitRefusedError, BindingError, initProject, projectStatus } from "@vcv/repo";
import { InputError, a, b, cmd, host, num, readInput, rest, values } from "./args.ts";
import { printDiagnostics, printOutcome, printProject, printTree } from "./print.ts";
import { USAGE } from "./usage.ts";
import { bindingCommand, evidenceCommand } from "./commands/bindings.ts";
import {
  handoffCommand,
  implementationCommand,
  integrityCommand,
  proposalCommand,
  reviewCommand,
} from "./commands/changes.ts";
import { criteriaCommand, gateCommand, reconcileCommand, testsCommand } from "./commands/premerge.ts";

function main(): number {
  switch (cmd) {
    case "validate": {
      const r = loadModel(readInput(a));
      console.log(r.ok ? `${a}: valid` : `${a}: invalid`);
      printDiagnostics(r.diagnostics);
      return r.ok ? 0 : 1;
    }
    case "init": {
      const r = loadModel(readInput(b));
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
      return printOutcome(new ModelEngine(new FileStore(a!)).propose(parseYaml(readInput(b)), host()));
    case "approve": {
      // Developer path: identity is asserted by flags/env, so it writes no attestation and the
      // integrity check reports the result as unattested (docs/approvals.md).
      const code = printOutcome(new ModelEngine(new FileStore(a!)).approve(b!, host()));
      console.log(
        "  note: developer approval (identity asserted by --as/--perm or VCV_HOST_*); no attestation. Use `vcv review approve` for a trusted reviewer approval.",
      );
      return code;
    }
    case "query": {
      // Opening the store runs recovery; queries themselves never write.
      const q = createQueryApi(new FileStore(a!));
      const dirs: Record<string, "incoming" | "outgoing" | "both"> = { in: "incoming", out: "outgoing", both: "both" };
      const opt = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
      const result =
        b === "overview"
          ? q.getProjectOverview()
          : b === "search"
            ? q.searchObjects(
                opt({ text: rest.join(" "), kinds: values.kind as never, limit: num(values.limit) }) as never,
              )
            : b === "context"
              ? q.getContext(
                  opt({
                    id: rest[0]!,
                    depth: num(values.depth),
                    direction: values.direction ? dirs[values.direction] : undefined,
                    maxNodes: num(values.limit),
                  }) as never,
                )
              : b === "impact"
                ? q.analyzeImpact(
                    opt({ ids: rest, maxDepth: num(values.depth), maxResults: num(values.limit) }) as never,
                  )
                : undefined;
      if (!result) {
        console.log(USAGE);
        return 1;
      }
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    case "project": {
      if (a === "status") {
        const st = projectStatus(b ?? ".");
        if (values.json) console.log(JSON.stringify(st, null, 2));
        else printProject(st);
        return st.state === "ready" ? 0 : 1;
      }
      if (a === "init" && b && rest[0]) {
        const r = loadModel(readInput(rest[0]));
        if (!r.ok || !r.model) {
          printDiagnostics(r.diagnostics);
          return 1;
        }
        printProject(initProject(b, r.model));
        return 0;
      }
      console.log(USAGE);
      return 1;
    }
    case "binding":
      return bindingCommand();
    case "evidence":
      return evidenceCommand();
    case "proposal":
      return proposalCommand();
    case "reviewer":
    case "review":
      return reviewCommand();
    case "integrity":
      return integrityCommand();
    case "handoff":
      return handoffCommand();
    case "reconcile":
      return reconcileCommand();
    case "criteria":
      return criteriaCommand();
    case "tests":
      return testsCommand();
    case "gate":
      return gateCommand();
    case "implementation":
      return implementationCommand();
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

function run(): void {
  try {
    host();
    process.exitCode = main();
  } catch (err) {
    // Store problems (e.g. CONFLICTED or DIVERGED after a Git merge) and unreadable inputs are
    // reported, not thrown at the user.
    if (err instanceof InputError) console.error(`✗ INPUT: ${err.message}`);
    else if (
      err instanceof StoreError ||
      err instanceof BindingError ||
      err instanceof ApprovalError ||
      err instanceof GitRefusedError
    )
      console.error(`✗ ${err.code}: ${err.message}`);
    else throw err;
    process.exitCode = 2;
  }
}

run();
