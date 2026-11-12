// vcv: a thin CLI adapter over the engine. It contains no domain logic; it only parses
// arguments, calls @vcv/ir / @vcv/core, and prints results.
//
// The CLI acts as the trusted host for a local single user: identity and permissions come
// from flags here, standing in for what a real session or OAuth token would supply.
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import { parseArgs } from "node:util";
import { loadModel, parseYaml, ownershipTree } from "../../../packages/ir/src/index.ts";
import type { Diagnostic, TreeNode } from "../../../packages/ir/src/index.ts";
import { FileStore, ModelEngine, StoreError } from "../../../packages/core/src/index.ts";
import { createQueryApi } from "../../../packages/query/src/index.ts";
import {
  ApprovalError,
  BindingError,
  addTrustedReviewer,
  checkIntegrity,
  createReviewerKey,
  reviewApprove,
  buildHandoff,
  reconcile,
  criteriaEvidence,
  preMergeGate,
  findWorkTreeRoot,
  captureTestRun,
  testIdentity,
  TEST_RUN_LIMITS,
  JUNIT_LIMITS,
  recordImplementation,
  implementationStatus,
  reviewFinalize,
  PROPOSAL_LIMITS,
  createEvidenceApi,
  listProposals,
  previewProposal,
  submitProposal,
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
import type { GateReport, Reconciliation, BindingHost, HintedDiagnostic, IntegrityReport, TrustSource, ProjectStatus, ProposalPreview, ProposalResult, Verification } from "../../../packages/repo/src/index.ts";
import type { BindingRelation, ClaimSource } from "../../../packages/core/src/index.ts";
import type { HostContext, ImplementationRequest, Outcome, Permission } from "../../../packages/core/src/index.ts";

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

  proposal submit <path> <change.yaml> [--json]
                                        Proposal-only: record a typed model change as pending for a separate
                                        reviewer. Never applies or approves, whatever --perm says; .vcv/HEAD
                                        does not move. (docs/proposals.md)
  proposal preview <path> <changeId> [--json] [--limit n]
  proposal preview <path> --file <change.yaml> [--json]
                                        Read-only review of a proposal (submitted, or a dry run of a file):
                                        operations, before/after delta, structural impact across modules and
                                        contracts, affected binding claims, diagnostics now, assumptions
  proposal list <path> [--states pending,stale,rejected,applied,invalid] [--json]

  reviewer init <key-file> --id <principal> [--add <path>]
                                        Create a reviewer Ed25519 key (private key to <key-file>, mode 0600;
                                        keep it outside the repository and any agent sandbox). Prints the
                                        public trust-list entry; --add appends it to <path>/.vcv/reviewers.json
  review approve <path> <changeId> --digest <proposalDigest> --key <key-file>
              (--trust-commit <full commit ID of the protected base, from the hosting service> [--trust-ref origin/main]
               | --trust <reviewer-owned file outside the checkout> | --trust-working-tree (UNSAFE development mode))
                                        The trusted reviewer step: identity and permission come from the key's
                                        entry in the trust list, never from --as/--perm/VCV_HOST_* (refused here).
                                        The trust anchor is required; a local ref alone is refused (anyone with a
                                        shell here can create or move one), so pin the commit or use your own file.
                                        Approves exactly the reviewed content and writes a signed attestation.
  review finalize <path> <changeId> --digest <proposalDigest> --key <key-file> (--trust-commit <sha> [--trust-ref <ref>] | --trust <file>)
                                        Write the missing attestation of an applied change, if approve committed
                                        but could not write it. Only the recorded approver; never overwrites.
  integrity <path> [--base <ref>] [--trust-ref <ref> [--trust-commit <sha>] | --trust <file> | --trust-working-tree] [--require-attestation] [--json]
                                        Read-only check of the .vcv/ history: every revision derived by its
                                        applied change's typed operations, records consistent, base history
                                        unchanged, approvals attested by trusted keys. Exit 1 on any error.

  reconcile <path> --base <full commit ID of the protected base> [--trust-ref <ref> [--trust-commit <sha>] | --trust <file>]
            [--require-attestation] [--json]
                                        Read-only pre-merge comparison of the candidate checkout (commits and
                                        dirty edits) with the base: model lineage and integrity, model delta and
                                        impact, changed files, binding claims verified now and compared with the
                                        merge base, and findings labelled checked / observed / not-checked.
                                        Not a gate: it reports, and exits 0 whenever a report was produced.

  criteria <path> [criterionId...] [--junit <report.xml> --runner <name> --invocation "<cmd>" [--root <dir>] [--before <d>]]
           [--run <test-run.json>]... [--coverage <coverage-summary.json>] [--json]
                                        Read-only: the approved acceptance criteria (required / optional) and the
                                        test cases mapped to each by \`tests\` claims, verified now (resolved,
                                        stale because the test or the criterion changed, missing after a rename,
                                        ambiguous title). Map one with: binding add <path> --object <criterionId>
                                        --relation tests --locator '<file>#test:Suite > case'. With --run, each mapped
                                        case's result in runs of this exact candidate: passed / failed / stale /
                                        missing / unknown per criterion (M4.3). --junit captures here, in this process:
                                        the only way a run is host-observed. --run records are claims, whatever they
                                        declare. Exit 0 whenever a report is produced.
  gate <path> --base <full commit ID of the protected base> [--junit <report.xml> --runner <name> --invocation "<cmd>" [--root <dir>] --before <identityDigest>]
       [--run <test-run.json>]... [--observations <file>] [--policy <host file> | --policy-at-base <repo path>] [--coverage <f>] [--json]
                                        The pre-merge policy gate (M4.4): integrity pinned to the base with attestation
                                        required, structural and binding findings, every criterion's mapped test cases
                                        in runs of this exact candidate (--junit with --before, the identity the host
                                        read before the tests ran: captured here = host-observed; without --before
                                        a claim), and
                                        agent observations (claims; references checked). Decides pass / warn / block
                                        by the policy (vcv-policy-1; defaults block anything required that is not a
                                        host-observed pass). Exit 0 pass or warn, 1 block, 2 usage or setup error.
  tests identity <path> [--json]        The candidate's identity (commit, uncommitted bytes, model revision, claims).
                                        Read it before running the tests and pass it to capture as --before.
  tests capture <path> --junit <report.xml> --runner <name> --invocation "<command>" [--root <dir>]
              [--runner-version <v>] [--before <identityDigest>] [--out <test-run.json>] [--json]
                                        Read a JUnit XML report (strict subset, counts checked) and bind it to the
                                        candidate as a test-run record. Host-observed only with tests:observe,
                                        otherwise agent-claimed. VCV runs no tests. Write the report and the record
                                        outside the checkout, or they change the candidate's identity.

  handoff <path> <changeId>             The bounded implementation handoff (JSON) of an applied, attested change:
                                        approved operations and request, delta, impact, affected binding claims
                                        verified now, base commit, scope, steps. Read-only and deterministic.
  implementation record <path> --report <file> [--expect <digest>] [--json]
                                        Record the agent's implementation report (.vcv/implementations/<id>.json):
                                        its claims kept apart from what VCV observes (changed files, scope,
                                        binding states); warns on out-of-scope edits, stale or unreasserted
                                        bindings, failed tests, unmet criteria. Never changes the model.
  implementation show <path> <changeId> [--json]
                                        A recorded report with VCV's observations recomputed now.

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

  evidence <path> overview [--states s,..] [--limit n] [--cursor c]
  evidence <path> object <id> [--relations r,..] [--selector-kinds k,..] [--states s,..] [--limit n] [--cursor c]
  evidence <path> binding <bindingId>
  evidence <path> refresh [bindingId...] [--since <observationToken>]
                                        Read-only source evidence for binding claims; print JSON. Every call
                                        recomputes against the working tree; refresh rechecks all claims and
                                        returns a token. --expected-revision <rev> guards any of them, and
                                        --request '<json>' passes the request object as MCP would.

  Locators: <file>, <file>#symbol:Class.member, <file>#route:POST /path, <file>#test:Suite > case
  (paths are repository-relative POSIX; routes are controller-relative, without a global prefix)

  --as <principal>      Who is acting (default: local-user)
  --perm <list>         Comma list (default: propose,apply,approve,binding:record,binding:dispute,tests:observe);
                        names without ":" mean model:<name>

  VCV_HOST_PRINCIPAL / VCV_HOST_PERMISSIONS, when set, fix the identity and permissions (same
  syntax) for a host that runs vcv on someone else's behalf, e.g. an agent wrapper. --as and
  --perm are then refused.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: "string" },
    perm: { type: "string" },
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
    cursor: { type: "string" },
    "expected-revision": { type: "string" },
    relations: { type: "string" },
    "selector-kinds": { type: "string" },
    states: { type: "string" },
    since: { type: "string" },
    request: { type: "string" },
    file: { type: "string" },
    digest: { type: "string" },
    key: { type: "string" },
    trust: { type: "string" },
    "trust-ref": { type: "string" },
    "trust-commit": { type: "string" },
    "trust-working-tree": { type: "boolean", default: false },
    base: { type: "string" },
    "require-attestation": { type: "boolean", default: false },
    add: { type: "string" },
    report: { type: "string" },
    junit: { type: "string" },
    root: { type: "string" },
    runner: { type: "string" },
    "runner-version": { type: "string" },
    invocation: { type: "string" },
    before: { type: "string" },
    out: { type: "string" },
    run: { type: "string", multiple: true },
    coverage: { type: "string" },
    policy: { type: "string" },
    "policy-at-base": { type: "string" },
    observations: { type: "string" },
  },
});
const [cmd, a, b, ...rest] = positionals;
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
/** A host-fixed identity (env) cannot be widened from the command line. */
function hostContext(): HostContext {
  const fixedAs = process.env.VCV_HOST_PRINCIPAL;
  const fixedPerm = process.env.VCV_HOST_PERMISSIONS;
  if ((fixedAs !== undefined && values.as !== undefined) || (fixedPerm !== undefined && values.perm !== undefined)) {
    throw new InputError("identity and permissions are fixed by this host (VCV_HOST_PRINCIPAL / VCV_HOST_PERMISSIONS); --as and --perm are not accepted");
  }
  const perm = fixedPerm ?? values.perm ?? "propose,apply,approve,binding:record,binding:dispute,tests:observe";
  return {
    principalId: fixedAs ?? values.as ?? "local-user",
    permissions: perm.split(",").map((p) => p.trim()).filter(Boolean).map((p) => (p.includes(":") ? p : `model:${p}`) as Permission),
  };
}
let ctx: HostContext;

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
    case "approve": {
      // Developer path: identity is asserted by flags/env, so it writes no attestation and the
      // integrity check reports the result as unattested (docs/approvals.md).
      const code = printOutcome(new ModelEngine(new FileStore(a!)).approve(b!, ctx));
      console.log("  note: developer approval (identity asserted by --as/--perm or VCV_HOST_*); no attestation. Use `vcv review approve` for a trusted reviewer approval.");
      return code;
    }
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

/** A proposal file: YAML or JSON, bounded before parsing. */
function readProposalFile(path: string | undefined): unknown {
  const text = readInput(path);
  if (Buffer.byteLength(text) > 4 * PROPOSAL_LIMITS.maxBytes) throw new InputError(`${path} is larger than ${4 * PROPOSAL_LIMITS.maxBytes} bytes; split the change`);
  try {
    return parseYaml(text);
  } catch (e) {
    throw new InputError(`${path} is not valid YAML or JSON: ${(e as Error).message.split("\n")[0]}`);
  }
}

function printHinted(ds: HintedDiagnostic[]) {
  for (const d of ds) {
    console.log(`  ${d.severity === "error" ? "✗" : "!"} ${d.code} at ${d.path || "(root)"}: ${d.message}`);
    if (d.hint) console.log(`      → ${d.hint}`);
  }
}

function printResultError(r: Extract<ProposalResult<unknown>, { ok: false }>) {
  console.log(`✗ ${r.error.code}: ${r.error.message}`);
  for (const d of r.error.details ?? []) console.log(`  ${d.path || "(root)"}: ${d.message}`);
}

function handoffCommand(): number {
  const r = buildHandoff(need(a, "<path>"), need(b, "<changeId>"));
  console.log(JSON.stringify(r.ok ? r.data : r, null, 2));
  return r.ok ? 0 : 1;
}

function reconcileCommand(): number {
  const r = reconcile(need(a, "<path>"), { base: need(values.base, "--base"), ...(trustSource(null) ? { trust: trustSource(null) } : {}), requireAttestation: values["require-attestation"] });
  if (values.json || !r.ok) {
    console.log(JSON.stringify(r.ok ? r.data : r, null, 2));
    return r.ok ? 0 : 1;
  }
  printReconciliation(r.data);
  return 0;
}

/** Read at most `limit` bytes of a regular file, refusing a larger one before reading it. */
function readBounded(file: string, limit: number): Buffer {
  let fd: number;
  try {
    // Nonblocking, so a FIFO or device is refused by its type below instead of blocking the open.
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch (e) {
    throw new InputError(`cannot read ${file}: ${(e as Error).message.split("\n")[0]}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new InputError(`${file} is not a regular file`);
    if (st.size > limit) throw new InputError(`${file} is ${st.size} bytes, more than the ${limit} read`);
    const buf = Buffer.alloc(limit + 1);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, n)) > 0; ) n += r;
    if (n > limit) throw new InputError(`${file} grew past ${limit} bytes while it was read`);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function readJson(file: string, what: string): unknown {
  const buf = readBounded(file, TEST_RUN_LIMITS.recordBytes);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw new InputError(`${file} is not a valid ${what}: ${(e as Error).message.split("\n")[0]}`);
  }
}

/** Total line coverage from an Istanbul `json-summary` (coverage-summary.json). Supporting context only. */
function readCoverage(file: string): { linesPct: number; source: string } {
  const pct = (readJson(file, "coverage summary") as { total?: { lines?: { pct?: unknown } } })?.total?.lines?.pct;
  if (typeof pct !== "number" || !(pct >= 0 && pct <= 100)) throw new InputError(`${file} has no total.lines.pct (an Istanbul json-summary is expected)`);
  return { linesPct: pct, source: "istanbul json-summary" };
}

function captureInput() {
  return {
    root: values.root ?? "",
    runner: { name: need(values.runner, "--runner"), ...(values["runner-version"] ? { version: values["runner-version"] } : {}) },
    invocation: need(values.invocation, "--invocation"),
    ...(values.before ? { before: values.before } : {}),
  };
}

function testsCommand(): number {
  const path = need(b, "<path>");
  if (a === "identity") {
    const r = testIdentity(path);
    if (values.json || !r.ok) console.log(JSON.stringify(r.ok ? r.data : r, null, 2));
    else {
      const c = r.data.candidate;
      console.log(r.data.identityDigest);
      console.log(`  commit ${c.commit ?? "(none)"}${c.branch ? ` (${c.branch})` : ""}; ${c.uncommitted.paths} uncommitted path(s); model ${c.modelRevision}`);
    }
    return r.ok ? 0 : 1;
  }
  if (a === "capture") {
    const junit = need(values.junit, "--junit");
    const r = captureTestRun(path, readBounded(junit, JUNIT_LIMITS.bytes), captureInput(), ctx);
    if (!r.ok) {
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else printResultError(r);
      return 1;
    }
    const text = `${JSON.stringify(r.data, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, text, { flag: "wx" });
    if (values.json || !values.out) process.stdout.write(text);
    else {
      const s = r.data.summary;
      console.log(`${values.out}: run captured by ${r.data.principalId}, declared ${r.data.observedBy}-observed (digest ${r.data.digest})`);
      console.log("  as a file this record is a claim: read back with --run it is never host-observed; use criteria --junit in the trusted job");
      console.log(`  ${s.tests} case(s): ${s.passed} passed, ${s.failed} failed, ${s.errors} error(s), ${s.skipped} skipped; candidate ${r.data.identityDigest.slice(0, 12)} at ${r.data.candidate.commit?.slice(0, 12) ?? "(no commit)"}`);
    }
    return 0;
  }
  console.log(USAGE);
  return 1;
}

function criteriaCommand(): number {
  const ids = [b, ...rest].filter((x): x is string => !!x);
  const path = need(a, "<path>");
  const runs: unknown[] = (values.run ?? []).map((f) => readJson(f, "test-run record"));
  // --junit: capture here, in this process, and evaluate that very record (host-observed with tests:observe).
  if (values.junit) {
    const cap = captureTestRun(path, readBounded(values.junit, JUNIT_LIMITS.bytes), captureInput(), ctx);
    if (!cap.ok) {
      console.log(JSON.stringify(cap, null, 2));
      return 1;
    }
    runs.unshift(cap.data);
  }
  const r = criteriaEvidence(path, { ...(ids.length ? { ids } : {}), ...(runs.length ? { runs } : {}), ...(values.coverage ? { coverage: readCoverage(values.coverage) } : {}) });
  if (values.json || !r.ok) {
    console.log(JSON.stringify(r.ok ? r.data : r, null, 2));
    return r.ok ? 0 : 1;
  }
  const d = r.data;
  const c = d.counts;
  console.log(`acceptance criteria at ${d.modelRevision}: ${c.criteria} (${c.required} required, ${c.optional} optional); ${c.mappings} test mapping(s)`);
  if (!d.mappingsAvailable) console.log(`  ! mappings NOT ASSESSED: ${d.mappingsProblem}`);
  else console.log(`  required: ${c.requiredUnmapped} unmapped, ${c.requiredNotResolved} not fully resolved${c.requiredIncomplete ? ` (${c.requiredIncomplete} with an incomplete assessment)` : ""}; optional: ${c.optionalUnmapped} unmapped`);
  for (const run of d.runs) {
    const s = run.summary;
    console.log(`  run ${run.index}: ${run.observedBy === "host" ? "host-observed (captured here)" : `CLAIMED (${run.admittedAs}, declares ${run.declaredObservedBy})`} ${run.runner.name} by ${run.principalId}, ${s.tests} case(s) (${s.passed} passed, ${s.failed} failed, ${s.errors} error(s), ${s.skipped} skipped); suite ${run.green ? "green" : "red"}; ${run.fresh ? "describes this candidate" : `STALE: ${run.staleBecause.join("; ")}`}`);
  }
  if (d.runs.length) {
    const q = d.results.required;
    console.log(`  required criteria: ${q.passed} passed, ${q.failed} failed, ${q.stale} stale, ${q.missing} missing, ${q.unknown} unknown`);
  }
  if (d.coverage) console.log(`  coverage: ${d.coverage.linesPct}% lines (${d.coverage.source}); ${d.coverage.note}`);
  for (const n of d.notes) console.log(`  ! ${n.code}: ${n.message}`);
  if (d.invalidClaims.total) {
    console.log(`  ! ${d.invalidClaims.total} claim file(s) cannot be read; any of them may map a criterion, so the assessment is INCOMPLETE:`);
    for (const x of d.invalidClaims.items) console.log(`    ${x.file}: ${x.problem}`);
  }
  for (const e of d.criteria) {
    console.log(`  ${e.id} [${e.verification}] ${e.result !== "unverified" ? `${e.result.toUpperCase()}${e.resultObservedBy ? (e.resultObservedBy === "host" ? " (host-observed)" : " (claimed, not host-observed)") : ""}; mapping ` : ""}${e.mapping}: ${e.statement}`);
    console.log(`    verifies ${e.verifies.join(", ")}`);
    for (const m of e.mappings) console.log(`    ${m.state.padEnd(13)} ${m.result ? `${m.result.status.padEnd(8)} ` : ""}${m.test ? `${m.test.path} > ${m.test.name}` : `(${m.relation} claim)`}  [${m.bindingId}]${m.alsoMapsTo.length ? `  also ${m.alsoMapsTo.join(", ")}` : ""}`);
    for (const p of e.problems) console.log(`    ! ${p.code}: ${p.message}`);
    if (e.mappingsTruncated || e.problemsTruncated) console.log(`    ! cut: ${e.mappings.length}/${e.mappingsTotal} mappings, ${e.problems.length}/${e.problemsTotal} problems`);
  }
  if (d.truncated || d.testsTruncated || d.invalidClaims.truncated || d.budget.shrunk) console.log(`  ! lists were cut (report ${d.budget.bytes}/${d.budget.limit} bytes); use --json for totals`);
  console.log(`  ${d.meaning}`);
  return 0;
}

/**
 * The pre-merge gate (M4.4). Exit 0: pass or warn. 1: block. 2: usage or setup problem (never a pass).
 * --junit reports are captured here, in this process; --run records are claims.
 */
function gateCommand(): number {
  const path = need(a, "<path>");
  const base = need(values.base, "--base");
  if (values.policy && values["policy-at-base"]) throw new InputError("give --policy or --policy-at-base, not both");
  const root = findWorkTreeRoot(path);
  let policy: unknown;
  if (values.policy) {
    // The policy is the host's: a file inside the candidate would let the candidate choose it.
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return resolvePath(p);
      }
    };
    if (root && (real(values.policy) + pathSep).startsWith(real(root) + pathSep)) {
      throw new InputError("--policy is inside the candidate checkout; pass a host-owned file, or read it from the base with --policy-at-base");
    }
    policy = readJson(values.policy, "gate policy");
  }
  // --before: the identity the host read BEFORE the tests ran. Without it the report is a claim.
  const junit = values.junit ? [{ report: readBounded(values.junit, JUNIT_LIMITS.bytes), root: values.root ?? "", runner: captureInput().runner, invocation: captureInput().invocation, ...(values.before ? { before: values.before } : {}) }] : [];
  if (values.before && !values.junit) throw new InputError("--before goes with --junit: it is the identity the host read before running the tests that wrote that report");
  const r = preMergeGate(path, {
    base,
    ...(junit.length ? { junit } : {}),
    ...(values.run?.length ? { runs: values.run.map((f) => readJson(f, "test-run record")) } : {}),
    ...(values.coverage ? { coverage: readCoverage(values.coverage) } : {}),
    ...(values.observations ? { observations: readJson(values.observations, "observations file") } : {}),
    ...(policy !== undefined ? { policy } : {}),
    ...(values["policy-at-base"] ? { policyAtBase: values["policy-at-base"] } : {}),
  }, ctx);
  if (!r.ok) {
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else printResultError(r);
    return 2;
  }
  if (values.json) console.log(JSON.stringify(r.data, null, 2));
  else printGate(r.data);
  return r.data.decision === "block" ? 1 : 0;
}

function printGate(d: GateReport) {
  const short = (c: string) => c.slice(0, 12);
  console.log(`vcv gate: ${d.decision.toUpperCase()}: ${d.headline}`);
  console.log(`  candidate ${short(d.candidate.commit)}${d.candidate.branch ? ` (${d.candidate.branch})` : ""} against base ${short(d.base.commit)}; ${d.change.kind} change (${d.change.changedFiles} file(s), ${d.change.introducedRevisions} new model revision(s), lineage ${d.change.lineage})`);
  console.log(`  policy: ${d.policy.source} (${short(d.policy.digest)})${d.policy.changedByCandidate ? "; the candidate changes it (applies after merge)" : ""}`);
  for (const run of d.runs) {
    const s = run.summary;
    console.log(`  run ${run.index}: ${run.observedBy === "host" ? "host-observed (captured here)" : "CLAIMED (imported)"} ${run.runner.name}: ${s.tests} case(s), ${s.passed} passed, ${s.failed} failed, ${s.errors} error(s), ${s.skipped} skipped; suite ${run.green ? "green" : "red"}${run.fresh ? "" : `; STALE: ${run.staleBecause.join("; ")}`}`);
  }
  for (const c of d.criteria.items) console.log(`  ${c.result === "passed" && c.observedBy === "host" ? "✓" : "✗"} ${c.id} [${c.verification}] ${c.result}${c.observedBy ? ` (${c.observedBy})` : ""}  verifies ${c.verifies.join(", ")}`);
  for (const r of d.reasons) {
    console.log(`  ${r.severity === "block" ? "BLOCK" : "warn "} ${r.code} [${r.rule}; ${r.basis}]${r.criterionId ? ` ${r.criterionId}` : ""}: ${r.message}`);
  }
  if (d.reasonsTruncated || d.criteria.truncated || d.observationsTruncated) console.log(`  ! lists were cut (${d.reasonsTotal} reasons in total); use --json`);
  for (const n of d.notes) console.log(`  note: ${n}`);
  for (const o of d.observations) console.log(`  agent claim ${o.id} (${o.kind}, references ${o.references}): ${o.statement.slice(0, 200)}`);
  console.log("  not established here:");
  for (const l of d.limits) console.log(`    - ${l}`);
}

function printReconciliation(d: Reconciliation) {
  const short = (c: string) => c.slice(0, 12);
  console.log(`reconciliation of ${d.candidate.projectId}: candidate ${short(d.candidate.commit)}${d.candidate.branch ? ` (${d.candidate.branch})` : ""}${d.candidate.dirty ? " + uncommitted edits" : ""} against base ${d.base.ref === d.base.commit ? short(d.base.commit) : `${d.base.ref} = ${short(d.base.commit)} (ref resolved locally; not pinned)`}`);
  if (!d.base.containedInCandidate) console.log(`  ! the candidate does not contain the base; changes are measured from the merge base ${short(d.base.mergeBase)}`);
  console.log(`  model: ${d.model.lineage}, ${d.base.modelRevision ?? "(no model)"} → ${d.candidate.modelRevision}; integrity ${d.model.integrity.ok ? "ok" : "FAILED"}; ${d.model.delta.total} object change(s)${d.model.impact ? `, ${d.model.impact.candidates.length} impact candidate(s), cross-module ${d.model.impact.crossModule}` : ""}`);
  for (const r of d.model.introduced) console.log(`    ${r.revision}: ${r.derivation}${r.changeId ? ` by ${r.changeId}` : ""}; approval ${r.approval}`);
  for (const c of d.model.delta.changes) console.log(`    ${c.change} ${c.kind} ${c.id}${c.fields.length ? ` (${c.fields.map((f) => f.field).join(", ")})` : ""}`);
  console.log(`  source: ${d.source.total} changed file(s), ${d.source.unmapped ?? "unknown (claims unreadable)"} file(s) outside .vcv/ unmapped`);
  for (const f of d.source.files) console.log(`    ${f.committed ? "C" : " "}${f.uncommitted ? "W" : " "} ${f.area.padEnd(12)} ${f.path}${f.bindings.length ? `  ← ${f.bindings.join(", ")}` : ""}`);
  if (d.sourceImpact) {
    const si = d.sourceImpact;
    console.log(`  source impact (declared-model context, not evidence of drift): seeds ${si.seeds.map((x) => x.objectId).join(", ")}; modules ${si.modules.map((m) => m.id).join(", ")}; ${si.total} impact candidate(s); cross-module ${si.crossModule}`);
    if (si.contracts.length) console.log(`    contracts: ${si.contracts.map((c) => `${c.id} (${c.via})`).join(", ")}`);
    if (si.rules.length) console.log(`    rules: ${si.rules.map((r) => `${r.id} (${r.via})`).join(", ")}`);
  }
  if (!d.bindings.available) console.log(`  bindings: NOT ASSESSED (${d.bindings.problem})`);
  else console.log(`  bindings: ${d.bindings.total} shown, ${d.bindings.unaffected} unaffected and resolved`);
  for (const b of d.bindings.items) console.log(`    ${b.bindingId}: ${b.state ?? "removed"}; claim ${b.atBase}; object ${b.object}${b.boundFileChanged ? "; bound file changed" : ""}`);
  console.log(`  findings (${d.findingsTotal}):`);
  for (const f of d.findings) console.log(`    [${f.category}/${f.basis}${f.related ? "" : ", unrelated"}] ${f.code}: ${f.message}`);
  if (d.budget.shrunk || d.findingsTruncated) console.log(`  ! lists were cut to fit the report budget (${d.budget.bytes}/${d.budget.limit} bytes); use --json for totals`);
  console.log(`  semantic: ${d.semantic.note}`);
  console.log("  not established here:");
  for (const l of d.limits) console.log(`    - ${l}`);
}

function printWarnings(ws: { code: string; message: string }[]) {
  for (const w of ws) console.log(`  ! ${w.code}: ${w.message}`);
}

function implementationCommand(): number {
  const path = need(b, "<path>");
  if (a === "record") {
    const r = recordImplementation(path, readProposalFile(need(values.report, "--report")), ctx, values.expect ?? null);
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else if (!r.ok) printResultError(r);
    else {
      const o = r.data.report.vcvObserved;
      console.log(`${r.data.file}: ${r.data.replaced ? "replaced" : "recorded"} (digest ${r.data.digest})`);
      console.log(`  change ${r.data.report.changeId} approved as ${r.data.report.approvedRevision}; claimed by ${r.data.report.agentClaims.claimedBy}; not reconciled`);
      console.log(`  ${o.filesModified.length} source file(s) changed since ${o.baseCommit.slice(0, 12)}, ${o.outOfScope.length} outside the approved scope; ${o.bindings.filter((x) => x.reasserted).length}/${o.bindings.length} affected binding(s) reasserted`);
      printWarnings(r.data.report.warnings);
    }
    return r.ok ? 0 : 1;
  }
  if (a === "show") {
    const r = implementationStatus(path, need(rest[0], "<changeId>"));
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else if (!r.ok) printResultError(r);
    else {
      console.log(`${r.data.file} (digest ${r.data.digest}): change ${r.data.report.changeId} at ${r.data.report.approvedRevision}; not reconciled`);
      console.log(`  observed now: ${r.data.now.filesModified.length} source file(s) changed, ${r.data.now.outOfScope.length} out of scope${r.data.changedSinceReport ? "; DIFFERENT from the recorded report" : "; same as recorded"}`);
      printWarnings(r.data.warningsNow);
    }
    return r.ok ? 0 : 1;
  }
  console.log(USAGE);
  return 1;
}

function printImplementationRequest(r: ImplementationRequest) {
  console.log("implementation requested (approved together with the operations):");
  console.log(`  behavior: ${r.behavior}`);
  for (const c of r.acceptanceCriteria) console.log(`  ✓? ${c}`);
  for (const t of r.suggestedTests ?? []) console.log(`  test: ${t}`);
  console.log(`  scope: ${r.scope?.join(", ") ?? "(not declared)"}`);
}

function printPreview(p: ProposalPreview, revision: string) {
  const q = p.proposal;
  console.log(`proposal ${q.changeId} (${q.origin === "record" ? `${q.lifecycle}, proposed by ${q.proposerId}` : "not submitted: dry run"})`);
  console.log(`  digest:   ${q.proposalDigest}`);
  console.log(`  base:     ${q.baseRevision}; this checkout is at ${revision}${p.validation.appliesToCurrent ? " (applies)" : " (does not apply now)"}`);
  if (q.rationale) console.log(`  why:      ${q.rationale}`);
  console.log(`  states:   change ${p.states.change}; approval ${p.states.approval}; snapshot ${p.states.snapshotStatus}; implementation ${p.states.implementation}`);
  console.log("operations:");
  for (const o of q.operations) console.log(`  ${o.index + 1}. ${o.summary}`);
  if (q.implementation) printImplementationRequest(q.implementation);
  if (p.validation.errors.length || p.validation.warnings.length) {
    console.log("validation now:");
    printHinted([...p.validation.errors, ...p.validation.warnings]);
  }
  if (p.delta) {
    console.log(`model delta (against ${p.delta.against} ${p.delta.revision}; ${p.delta.total} object(s)${p.delta.truncated ? ", truncated" : ""}):`);
    for (const c of p.delta.changes) {
      console.log(`  ${c.change === "added" ? "+" : c.change === "removed" ? "-" : "~"} ${c.kind} ${c.id}${c.moduleId ? ` [${c.moduleId}]` : ""}`);
      if (c.change === "modified") for (const f of c.fields) console.log(`      ${f.field}: ${f.before ?? "(none)"}\n        → ${f.after ?? "(none)"}`);
    }
  }
  if (p.impact) {
    console.log(`impact (structural candidates only)${p.impact.crossModule === "yes" ? ": CROSS-MODULE" : p.impact.crossModule === "not-determined" ? ": cross-module not determined" : ""}:`);
    console.log(`  modules:   ${p.impact.modules.map((m) => `${m.id} (${m.via})`).join(", ") || "(none)"}`);
    console.log(`  contracts: ${p.impact.contracts.map((c) => `${c.id} (${c.via})`).join(", ") || "(none)"}`);
    for (const c of p.impact.candidates) console.log(`  · ${c.kind} ${c.id}: ${c.reason}`);
    if (p.impact.truncated) console.log(`  … ${p.impact.total} candidates in all (cut by budget)`);
  }
  console.log(`binding claims to revisit (${p.bindings.total}):`);
  for (const b of p.bindings.items) console.log(`  ${b.bindingId}: ${b.modelObjectId} ${b.relation} ${b.locator} (${b.why})`);
  console.log("not verified by anyone yet:");
  for (const a of p.assumptions) console.log(`  - ${a}`);
}

function proposalCommand(): number {
  const path = need(b, "<path>");
  switch (a) {
    case "submit": {
      const r = submitProposal(path, readProposalFile(rest[0]), ctx);
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else if (!r.ok) printResultError(r);
      else {
        const d = r.data;
        console.log(`${d.changeId ?? "(no change id)"}: ${d.status}${d.recorded ? " (recorded)" : " (not recorded)"}; .vcv/HEAD stays at ${d.modelRevision.after}`);
        if (d.proposalDigest) console.log(`  digest: ${d.proposalDigest}`);
        printHinted(d.diagnostics);
        console.log(`  ${d.next}`);
      }
      return r.ok && r.data.ok ? 0 : 1;
    }
    case "preview": {
      if ((rest[0] === undefined) === (values.file === undefined)) throw new InputError("pass a change ID or --file <change.yaml>, not both");
      const req = { ...(values.file !== undefined ? { change: readProposalFile(values.file) } : { changeId: rest[0] }), ...(values.limit !== undefined ? { limit: num(values.limit) } : {}) };
      const r = previewProposal(path, req);
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else if (!r.ok) printResultError(r);
      else printPreview(r.data, r.context.modelRevision);
      return r.ok ? 0 : 1;
    }
    case "list": {
      const lifecycles = values.states?.split(",").map((x) => x.trim()).filter(Boolean);
      const r = listProposals(path, { ...(lifecycles ? { lifecycles } : {}), ...(values.limit !== undefined ? { limit: num(values.limit) } : {}) });
      if (values.json) console.log(JSON.stringify(r, null, 2));
      else if (!r.ok) printResultError(r);
      else {
        for (const p of r.data.proposals) {
          console.log(`${p.changeId}  ${p.lifecycle}${p.stale ? ` (${p.stale.reason})` : ""}  by ${p.proposerId ?? "?"}  base ${p.baseRevision ?? "?"}${p.resultingRevision ? ` → ${p.resultingRevision}` : ""}  ${p.operations} op(s)${p.problem ? `  ${p.problem}` : ""}`);
        }
        if (r.data.truncated) console.log(`… ${r.data.matched} in all`);
      }
      return r.ok ? 0 : 1;
    }
    default:
      console.log(USAGE);
      return 1;
  }
}

/** Review commands take no identity from flags or the environment: the key and trust list decide. */
function refuseAssertedIdentity(what: string) {
  if (values.as !== undefined || values.perm !== undefined || process.env.VCV_HOST_PRINCIPAL !== undefined || process.env.VCV_HOST_PERMISSIONS !== undefined) {
    throw new InputError(`${what} takes no --as/--perm and refuses to run under VCV_HOST_PRINCIPAL/VCV_HOST_PERMISSIONS (an agent host); the reviewer's identity comes from --key and the trust list`);
  }
}

function trustSource(defaultRef: string | null): TrustSource | undefined {
  const pinned = values["trust-commit"];
  const given = [values.trust !== undefined, values["trust-ref"] !== undefined || pinned !== undefined, values["trust-working-tree"]].filter(Boolean).length;
  if (given > 1) throw new InputError("pass one of --trust <file>, --trust-ref <ref> or --trust-working-tree");
  if (values.trust !== undefined) return { kind: "file", path: values.trust };
  if (pinned !== undefined) return { kind: "git-ref", ref: values["trust-ref"] ?? pinned, pinnedCommit: pinned };
  if (values["trust-ref"] !== undefined) return { kind: "git-ref", ref: values["trust-ref"] };
  if (values["trust-working-tree"]) return { kind: "working-tree" };
  return defaultRef ? { kind: "git-ref", ref: defaultRef } : undefined;
}

function reviewCommand(): number {
  if (cmd === "reviewer") {
    if (a !== "init") {
      console.log(USAGE);
      return 1;
    }
    refuseAssertedIdentity("vcv reviewer init");
    const entry = createReviewerKey(need(values.id, "--id"), need(b, "<key-file>"));
    console.log(`private key written to ${b} (mode 0600). Keep it outside the repository and any agent sandbox.`);
    console.log("trust-list entry (add it to .vcv/reviewers.json through a reviewed PR to the protected branch):");
    console.log(JSON.stringify(entry, null, 2));
    if (values.add !== undefined) console.log(`added to ${addTrustedReviewer(values.add, entry)}; commit it`);
    return 0;
  }
  if (a !== "approve" && a !== "finalize") {
    console.log(USAGE);
    return 1;
  }
  refuseAssertedIdentity(`vcv review ${a}`);
  const path = need(b, "<path>");
  const trust = trustSource(null);
  if (!trust) throw new InputError("a trust anchor is required: --trust-commit <full commit ID of the protected base, from the hosting service> [--trust-ref origin/main], or --trust <reviewer-owned file outside the checkout> (--trust-working-tree is an unsafe development mode)");
  const unsafe = trust.kind === "working-tree";
  if (unsafe) console.log("! UNSAFE development mode: the trust list comes from the checkout under review; this is not a trusted approval and a strict integrity check rejects it");
  const input = { changeId: need(rest[0], "<changeId>"), expectedDigest: need(values.digest, "--digest"), keyFile: need(values.key, "--key"), trust, allowUnprotectedTrust: unsafe };
  const r = a === "approve" ? reviewApprove(path, input) : reviewFinalize(path, input);
  console.log(`reviewer: ${r.reviewer.id} (key ${r.reviewer.keyFingerprint}, trusted per ${r.reviewer.trustSource})`);
  console.log(`  trust anchor: ${r.reviewer.trustAnchor}`);
  console.log(`  ! authorization ${r.authorization}`);
  const code = printOutcome(r.outcome);
  if (r.attestation) console.log(`  attestation: ${r.attestation.file}${r.attestation.alreadyPresent ? " (already present; unchanged)" : " (commit it with the change record and the new revision)"}`);
  return code;
}

function printIntegrity(r: IntegrityReport) {
  console.log(`integrity: ${r.ok ? "ok" : "FAILED"}${r.projectId ? ` (${r.projectId} at ${r.revision})` : ""}`);
  if (r.base) console.log(`  base:  ${r.base.ref} ${r.base.commit.slice(0, 12)} at ${r.base.revision ?? "(no .vcv/)"}`);
  console.log(`  trust: ${r.trust ? `${r.trust.source}, ${r.trust.reviewers} reviewer(s); ${r.trust.anchor}` : "none"}`);
  console.log(`  authorization: ${r.authorization}`);
  for (const c of r.revisions) {
    console.log(`  ${c.seq}. ${c.revision}${c.introduced ? " (new)" : ""}: ${c.derivation}${c.changeId ? ` by ${c.changeId}` : ""}; approval ${c.approval.state}${c.approval.detail ? ` (${c.approval.detail})` : ""}`);
  }
  for (const p of r.problems) console.log(`  ${p.severity === "error" ? "✗" : "!"} ${p.code}: ${p.message}`);
  console.log("  not provable here:");
  for (const l of r.limits) console.log(`    - ${l}`);
}

function integrityCommand(): number {
  const r = checkIntegrity(need(a, "<path>"), { trust: trustSource(null), ...(values.base !== undefined ? { base: values.base } : {}), requireAttestation: values["require-attestation"] });
  if (values.json) console.log(JSON.stringify(r, null, 2));
  else printIntegrity(r);
  return r.ok ? 0 : 1;
}

function evidenceCommand(): number {
  const api = createEvidenceApi(need(a, "<path>"));
  const list = (v: string | undefined) => (v === undefined ? undefined : v.split(",").map((x) => x.trim()).filter(Boolean));
  let request: Record<string, unknown>;
  if (values.request !== undefined) {
    try {
      request = JSON.parse(values.request);
    } catch {
      throw new InputError("--request must be a JSON object");
    }
  } else {
    const opt = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    const common = { expectedRevision: values["expected-revision"], limit: num(values.limit), cursor: values.cursor };
    request =
      b === "overview" ? opt({ ...common, states: list(values.states) })
      : b === "object" ? opt({ ...common, id: rest[0], relations: list(values.relations), selectorKinds: list(values["selector-kinds"]), states: list(values.states) })
      : b === "binding" ? opt({ expectedRevision: values["expected-revision"], bindingId: rest[0] })
      : b === "refresh" ? opt({ ...common, bindingIds: rest.length ? rest : undefined, since: values.since })
      : {};
  }
  const result =
    b === "overview" ? api.getEvidenceOverview(request as never)
    : b === "object" ? api.getObjectEvidence(request as never)
    : b === "binding" ? api.getBindingEvidence(request as never)
    : b === "refresh" ? api.refreshEvidence(request as never)
    : undefined;
  if (!result) {
    console.log(USAGE);
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

try {
  ctx = hostContext();
  process.exitCode = main();
} catch (err) {
  // Store problems (e.g. CONFLICTED or DIVERGED after a Git merge) and unreadable inputs are
  // reported, not thrown at the user.
  if (err instanceof InputError) console.error(`✗ INPUT: ${err.message}`);
  else if (err instanceof StoreError || err instanceof BindingError || err instanceof ApprovalError) console.error(`✗ ${err.code}: ${err.message}`);
  else throw err;
  process.exitCode = 2;
}
