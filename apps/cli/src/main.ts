// vcv: a thin CLI adapter over the engine. It contains no domain logic; it only parses
// arguments, calls @vcv/ir / @vcv/core, and prints results.
//
// The CLI acts as the trusted host for a local single user: identity and permissions come
// from flags here, standing in for what a real session or OAuth token would supply.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadModel, parseYaml, ownershipTree } from "../../../packages/ir/src/index.ts";
import type { Diagnostic, TreeNode } from "../../../packages/ir/src/index.ts";
import { FileStore, ModelEngine, StoreError } from "../../../packages/core/src/index.ts";
import { createQueryApi } from "../../../packages/query/src/index.ts";
import {
  BindingError,
  disputeBinding,
  formatLocator,
  initProject,
  listBindings,
  parseLocator,
  projectStatus,
  readBinding,
  recordBinding,
  removeBinding,
  verifyBinding,
  verifyBindings,
} from "../../../packages/repo/src/index.ts";
import type { BindingHost, ProjectStatus, Verification } from "../../../packages/repo/src/index.ts";
import type { BindingRelation, ClaimSource } from "../../../packages/core/src/index.ts";
import type { HostContext, Outcome, Permission } from "../../../packages/core/src/index.ts";

const USAGE = `vcv <command> [options]

  validate <model.yaml>                 Check a model file (schema, references, consistency)
  init <store-dir> <model.yaml>         Start a model store from a valid model file
  show <store-dir> [--tree]             Print the current revision (or its ownership tree)
  propose <store-dir> <change.yaml>     Submit a change
  approve <store-dir> <changeId>        Approve a pending change
  query <store-dir> overview            Read-only semantic queries; print JSON
  query <store-dir> search <text...> [--kind k] [--limit n]
  query <store-dir> context <id> [--depth n] [--direction in|out|both] [--limit n]
  query <store-dir> impact <id...> [--depth n] [--limit n]
  project status [path] [--json]        Find .vcv/ in the checkout containing path; report model + Git state
  project init <path> <model.yaml>      Create .vcv/ at the checkout root from a valid model file

  binding add <path> --object <id> --relation <r> --locator <loc> --source agent|human|tool
              [--id <bindingId>] [--rationale <text>] [--confidence <0..1>] [--revision <rev>] [--allow-unchecked]
                                        Record a claim that code implements|exposes|persists|tests a model object
  binding reassert <path> <bindingId> --locator <loc> --expect <digest> --source agent|human|tool [--rationale ...]
                                        Replace a claim (e.g. after a rename); the model revision does not change
  binding remove <path> <bindingId> --expect <digest>
  binding dispute <path> <bindingId> --reason <text> --expect <digest>
  binding list <path> [--json]          Claims with their digests (pass a digest to --expect)
  binding verify <path> [bindingId] [--json]
                                        Does each locator still resolve, and did the code or model change?
                                        Says nothing about whether the code does what the claim says.

  Locators: <file>, <file>#symbol:Class.member, <file>#route:POST /path, <file>#test:Suite > case
  (paths are repository-relative POSIX; routes are controller-relative, without a global prefix)

  --as <principal>      Who is acting (default: local-user)
  --perm <list>         Comma list (default: propose,apply,approve,binding:record,binding:dispute);
                        names without ":" mean model:<name>`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: "string", default: "local-user" },
    perm: { type: "string", default: "propose,apply,approve,binding:record,binding:dispute" },
    object: { type: "string" },
    relation: { type: "string" },
    locator: { type: "string" },
    source: { type: "string" },
    id: { type: "string" },
    rationale: { type: "string" },
    confidence: { type: "string" },
    revision: { type: "string" },
    expect: { type: "string" },
    reason: { type: "string" },
    "allow-unchecked": { type: "boolean", default: false },
    tree: { type: "boolean", default: false },
    kind: { type: "string", multiple: true },
    limit: { type: "string" },
    depth: { type: "string" },
    direction: { type: "string" },
    json: { type: "boolean", default: false },
  },
});
const [cmd, a, b, ...rest] = positionals;
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const ctx: HostContext = {
  principalId: values.as!,
  permissions: values.perm!.split(",").map((p) => p.trim()).filter(Boolean).map((p) => (p.includes(":") ? p : `model:${p}`) as Permission),
};

function bindingHost(): BindingHost {
  const source = values.source;
  if (source !== "agent" && source !== "human" && source !== "tool") throw new InputError("--source agent|human|tool is required: say who makes this claim");
  return { ...ctx, source: source as ClaimSource };
}
function need(v: string | undefined, flag: string): string {
  if (!v) throw new InputError(`${flag} is required`);
  return v;
}
function locatorArg(): ReturnType<typeof parseLocator> {
  try {
    return parseLocator(need(values.locator, "--locator"));
  } catch (e) {
    throw new InputError(`--locator: ${(e as Error).message}`);
  }
}
function printVerification(v: Verification) {
  const c = v.claim;
  if (!c) {
    console.log(`${v.bindingId}: invalid (${v.problem})`);
    return;
  }
  console.log(`${v.bindingId}: ${v.state}  ${c.modelObjectId} ${c.relation} ${formatLocator(c.locator)}`);
  console.log(`  claimed by ${c.provenance.source} ${c.provenance.principalId} at ${c.modelRevision}${c.provenance.confidence !== undefined ? `, confidence ${c.provenance.confidence}` : ""}; meaning not verified by VCV`);
  console.log(`  locator: ${v.locator!.state}: ${v.locator!.detail}`);
  console.log(`  source:  ${v.source!.state}: ${v.source!.cause}`);
  console.log(`  model:   ${v.model!.state}: ${v.model!.cause}`);
  if (v.git.commitMoved) console.log(`  git:     commit moved since the claim (not evidence of drift by itself); file is ${v.git.workingTree}`);
  if (v.disputed) console.log(`  disputed by ${v.disputed.by}: ${v.disputed.reason}`);
}

/** An input file the user named that cannot be read: reported as a diagnostic, not a stack trace. */
class InputError extends Error {}
function readInput(path: string | undefined): string {
  if (!path) throw new InputError("a file argument is missing");
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new InputError(`cannot read ${path}${code === "ENOENT" ? ": no such file" : code === "EISDIR" ? ": is a directory" : code ? ` (${code})` : ""}`);
  }
}

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

function printProject(s: ProjectStatus) {
  console.log(`project: ${s.state} (${s.storeDir})`);
  if (s.model) console.log(`model:   ${s.model.projectId} at ${s.model.revision} [${s.model.status}], ${s.model.history.length} revision(s)`);
  if (s.git) {
    const where = s.git.branch ?? `detached at ${s.git.commit?.slice(0, 12) ?? "(no commits)"}`;
    console.log(`git:     ${where}${s.git.commit ? ` ${s.git.commit.slice(0, 12)}` : ""}${s.git.dirty ? ", working tree dirty" : ", clean"}${s.git.operation ? `, ${s.git.operation} in progress` : ""}`);
  }
  for (const d of s.diagnostics) console.log(`  ${d.severity === "error" ? "✗" : d.severity === "warning" ? "!" : "·"} ${d.code}: ${d.message}`);
}

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
      return printOutcome(new ModelEngine(new FileStore(a!)).propose(parseYaml(readInput(b)), ctx));
    case "approve":
      return printOutcome(new ModelEngine(new FileStore(a!)).approve(b!, ctx));
    case "query": {
      // Opening the store runs recovery; queries themselves never write.
      const q = createQueryApi(new FileStore(a!));
      const dirs: Record<string, "incoming" | "outgoing" | "both"> = { in: "incoming", out: "outgoing", both: "both" };
      const opt = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
      const result =
        b === "overview" ? q.getProjectOverview()
        : b === "search" ? q.searchObjects(opt({ text: rest.join(" "), kinds: values.kind as never, limit: num(values.limit) }) as never)
        : b === "context" ? q.getContext(opt({ id: rest[0]!, depth: num(values.depth), direction: values.direction ? dirs[values.direction] : undefined, maxNodes: num(values.limit) }) as never)
        : b === "impact" ? q.analyzeImpact(opt({ ids: rest, maxDepth: num(values.depth), maxResults: num(values.limit) }) as never)
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
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

function bindingCommand(): number {
  const path = need(b, "<path>");
  const id = rest[0];
  switch (a) {
    case "add": {
      const conf = values.confidence === undefined ? undefined : Number(values.confidence);
      const r = recordBinding(
        path,
        {
          ...(values.id ? { bindingId: values.id } : {}),
          modelObjectId: need(values.object, "--object"),
          relation: need(values.relation, "--relation") as BindingRelation,
          locator: locatorArg(),
          ...(values.rationale !== undefined ? { rationale: values.rationale } : {}),
          ...(conf !== undefined ? { confidence: conf } : {}),
          ...(values.revision ? { modelRevision: values.revision } : {}),
          allowUnchecked: values["allow-unchecked"],
        },
        bindingHost(),
        null,
      );
      console.log(`${r.entry.bindingId}: recorded (${r.resolution.state}: ${r.resolution.detail})`);
      console.log(`  digest: ${r.entry.digest}`);
      console.log(`  file:   ${r.entry.file} (commit it with the code; the model revision is unchanged)`);
      return 0;
    }
    case "reassert": {
      const bindingId = need(id, "<bindingId>");
      const expected = need(values.expect, "--expect");
      const old = readBinding(path, bindingId);
      if (!old?.claim) throw new BindingError(old ? "INVALID_CLAIM" : "NOT_FOUND", old ? `binding ${bindingId} is unreadable: ${old.problem}` : `binding ${bindingId} does not exist`);
      const conf = values.confidence === undefined ? undefined : Number(values.confidence);
      const r = recordBinding(
        path,
        {
          bindingId,
          modelObjectId: old.claim.modelObjectId,
          relation: old.claim.relation,
          locator: locatorArg(),
          ...(values.rationale !== undefined ? { rationale: values.rationale } : {}),
          ...(conf !== undefined ? { confidence: conf } : {}),
          ...(values.revision ? { modelRevision: values.revision } : {}),
          allowUnchecked: values["allow-unchecked"],
        },
        bindingHost(),
        expected,
      );
      console.log(`${bindingId}: reasserted (${r.resolution.state}: ${r.resolution.detail})`);
      console.log(`  digest: ${r.entry.digest}`);
      return 0;
    }
    case "remove":
      removeBinding(path, need(id, "<bindingId>"), { ...ctx, source: "human" }, need(values.expect, "--expect"));
      console.log(`${id}: removed`);
      return 0;
    case "dispute": {
      const e = disputeBinding(path, need(id, "<bindingId>"), need(values.reason, "--reason"), { ...ctx, source: "human" }, need(values.expect, "--expect"));
      console.log(`${id}: disputed by ${ctx.principalId}`);
      console.log(`  digest: ${e.digest}`);
      return 0;
    }
    case "list": {
      const entries = listBindings(path);
      if (values.json) console.log(JSON.stringify(entries, null, 2));
      else for (const e of entries) console.log(`${e.bindingId}  ${e.digest}  ${e.claim ? `${e.claim.modelObjectId} ${e.claim.relation} ${formatLocator(e.claim.locator)}` : `invalid: ${e.problem}`}`);
      return 0;
    }
    case "verify": {
      let vs: Verification[];
      if (id) {
        const e = readBinding(path, id);
        if (!e) throw new BindingError("NOT_FOUND", `binding ${id} does not exist`);
        vs = [verifyBinding(path, e)];
      } else vs = verifyBindings(path);
      if (values.json) console.log(JSON.stringify(vs, null, 2));
      else vs.forEach(printVerification);
      return vs.every((v) => v.state === "resolved") ? 0 : 1;
    }
    default:
      console.log(USAGE);
      return 1;
  }
}

try {
  process.exitCode = main();
} catch (err) {
  // Store problems (e.g. CONFLICTED or DIVERGED after a Git merge) and unreadable inputs are
  // reported, not thrown at the user.
  if (err instanceof InputError) console.error(`✗ INPUT: ${err.message}`);
  else if (err instanceof StoreError || err instanceof BindingError) console.error(`✗ ${err.code}: ${err.message}`);
  else throw err;
  process.exitCode = 2;
}
