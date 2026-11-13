// The `vcv` help text.
export const USAGE = `vcv <command> [options]

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
