// The CLI as an agent uses it during bootstrap (Issue #11): validate → project init → status,
// with readable diagnostics instead of stack traces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dirname, "../src/main.ts");
const FIXTURE = join(import.meta.dirname, "../../../examples/enrollment/model.rev-1.yaml");
const vcv = (...args: string[]) => spawnSync("node", ["--experimental-strip-types", "--no-warnings", MAIN, ...args], { encoding: "utf8" });
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vcv-cli-")));

test("an unreadable input file is a one-line diagnostic with exit code 2, not a stack trace", () => {
  for (const args of [["validate", "/nonexistent/model.yaml"], ["project", "init", tmp(), "/nonexistent/model.yaml"]]) {
    const r = vcv(...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stderr.trim(), "✗ INPUT: cannot read /nonexistent/model.yaml: no such file");
    assert.doesNotMatch(r.stderr, /at |node:fs/);
  }
  assert.equal(vcv("validate", tmp()).stderr.trim().endsWith(": is a directory"), true);
});

test("validate reports diagnostics with codes and paths, and exit 1 for an invalid model", () => {
  const dir = tmp();
  const file = join(dir, "bad.yaml");
  writeFileSync(file, 'schemaVersion: "0.2"\nproject: { id: p, name: P, modelRevision: rev-1, status: draft }\nmodules:\n  - { id: m, kind: module, owner: p, name: M, dependsOn: [nope] }\n');
  const r = vcv("validate", file);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /invalid\n {2}✗ UNKNOWN_REF at modules\[0\]\.dependsOn\[0\]: "nope" does not exist/);
});

test("project init creates .vcv/ in a Git checkout, then status reports it ready", () => {
  const repo = tmp();
  execFileSync("git", ["init", "-q", repo]);
  assert.equal(vcv("project", "status", repo).status, 1, "absent before init");
  const init = vcv("project", "init", repo, FIXTURE);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /project: ready/);
  const st = vcv("project", "status", repo, "--json");
  assert.equal(st.status, 0);
  assert.equal(JSON.parse(st.stdout).state, "ready");
  const again = vcv("project", "init", repo, FIXTURE);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /✗ ALREADY_INITIALIZED/);
});

test("binding add → list → verify → reassert --expect on Course Desk, without changing the model revision", () => {
  const ROOT = join(import.meta.dirname, "../../..");
  const repo = join(tmp(), "course-desk");
  execFileSync("bash", [join(ROOT, "examples/reference-app/materialize.sh"), repo]);
  assert.equal(vcv("project", "init", repo, join(ROOT, "docs/samples/m2.3-bootstrap/agent-output/model.yaml")).status, 0);
  const svc = "server/src/enrollment/enrollment.service.ts";
  const add = ["binding", "add", repo, "--object", "cap-enroll", "--relation", "implements", "--locator", `${svc}#symbol:EnrollmentService.enroll`, "--id", "impl.cap-enroll"];

  const noSource = vcv(...add);
  assert.equal(noSource.status, 2);
  assert.match(noSource.stderr, /✗ INPUT: --source agent\|human\|tool is required/);
  const ok = vcv(...add, "--source", "agent", "--as", "agent:demo");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /impl\.cap-enroll: recorded \(resolved: symbol EnrollmentService\.enroll resolves to method/);
  assert.match(vcv(...add, "--source", "agent").stderr, /✗ BINDING_EXISTS/);
  const missing = vcv("binding", "add", repo, "--object", "cap-enroll", "--relation", "implements", "--locator", `${svc}#symbol:EnrollmentService.reject`, "--source", "agent");
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /✗ LOCATOR_MISSING/);

  const verify = vcv("binding", "verify", repo);
  assert.equal(verify.status, 0);
  assert.match(verify.stdout, /impl\.cap-enroll: resolved .*\n {2}claimed by agent agent:demo at rev-1; meaning not verified by VCV/);

  const text = readFileSync(join(repo, svc), "utf8");
  writeFileSync(join(repo, svc), text.replace("  enroll(request", "  enrollStudent(request"));
  const broken = vcv("binding", "verify", repo, "impl.cap-enroll");
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /impl\.cap-enroll: missing/);

  const digest = vcv("binding", "list", repo).stdout.split(/\s+/)[1]!;
  assert.match(vcv("binding", "reassert", repo, "impl.cap-enroll", "--locator", `${svc}#symbol:EnrollmentService.enrollStudent`, "--source", "human").stderr, /--expect is required/);
  assert.match(vcv("binding", "reassert", repo, "impl.cap-enroll", "--locator", `${svc}#symbol:EnrollmentService.enrollStudent`, "--source", "human", "--expect", "0".repeat(64)).stderr, /✗ BINDING_CHANGED/);
  const re = vcv("binding", "reassert", repo, "impl.cap-enroll", "--locator", `${svc}#symbol:EnrollmentService.enrollStudent`, "--source", "human", "--expect", digest);
  assert.equal(re.status, 0, re.stderr);
  assert.equal(vcv("binding", "verify", repo).status, 0);
  assert.match(vcv("project", "status", repo).stdout, /at rev-1 \[draft\], 1 revision/);
});

test("evidence: flags build the same request as --request, and the result is JSON with exit 1 on an error", async () => {
  const { baseline, SERVICE, edit } = await import("../../../packages/repo/test/course-desk.ts");
  const repo = baseline();
  edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length > course.capacity");
  const json = (r: ReturnType<typeof vcv>) => JSON.parse(r.stdout);
  const same = (flags: string[], request: unknown) => {
    const a = vcv("evidence", repo, ...flags);
    const b = vcv("evidence", repo, flags[0]!, "--request", JSON.stringify(request));
    assert.equal(a.status, b.status);
    assert.deepEqual(json(a), json(b));
    return json(a);
  };
  assert.equal(same(["overview", "--states", "stale,missing", "--limit", "1"], { states: ["stale", "missing"], limit: 1 }).data.matched, 2);
  same(["object", "cap-enroll", "--relations", "implements", "--selector-kinds", "symbol", "--expected-revision", "rev-1"], { id: "cap-enroll", relations: ["implements"], selectorKinds: ["symbol"], expectedRevision: "rev-1" });
  same(["binding", "impl.cap-enroll"], { bindingId: "impl.cap-enroll" });
  const token = same(["refresh"], {}).data.observationToken;
  assert.equal(same(["refresh", "test.rul-seat-limit", "--since", token], { bindingIds: ["test.rul-seat-limit"], since: token }).data.changedSince, true);
  const missing = vcv("evidence", repo, "object", "cap-nope");
  assert.equal(missing.status, 1);
  assert.equal(json(missing).error.code, "UNKNOWN_ID");
  assert.equal(vcv("evidence", repo, "object", "--request", "{nope").stderr.trim(), "✗ INPUT: --request must be a JSON object");
});

test("review approve: refused under an agent host or with --as/--perm; a trusted key applies the reviewed digest; integrity exits 0, then 1 on a tampered store", async () => {
  const { baseline, git } = await import("../../../packages/repo/test/course-desk.ts");
  const repo = baseline();
  const key = join(tmp(), "hoang.pem");
  const init = vcv("reviewer", "init", key, "--id", "user:hoang", "--add", repo);
  assert.equal(init.status, 0, init.stderr);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "trust user:hoang");
  git(repo, "checkout", "-q", "-b", "feature");
  const file = join(tmp(), "change.json");
  writeFileSync(file, JSON.stringify({ changeId: "chg-a", projectId: "prj-course-desk", expectedRevision: "rev-1", rationale: "x", operations: [{ type: "setDescription", objectId: "mod-web", description: "new" }] }));
  const agentEnv = { ...process.env, VCV_HOST_PRINCIPAL: "agent:coder", VCV_HOST_PERMISSIONS: "model:propose" };
  const run = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync("node", ["--experimental-strip-types", "--no-warnings", MAIN, ...args], { encoding: "utf8", env });
  assert.equal(run(agentEnv, "proposal", "submit", repo, file).status, 0);
  const digest = JSON.parse(vcv("proposal", "preview", repo, "chg-a", "--json").stdout).data.proposal.proposalDigest as string;
  const mainSha = git(repo, "rev-parse", "main");

  const asAgent = run(agentEnv, "review", "approve", repo, "chg-a", "--digest", digest, "--key", key, "--trust-ref", "main", "--trust-commit", mainSha);
  assert.equal(asAgent.status, 2);
  assert.match(asAgent.stderr, /refuses to run under VCV_HOST_PRINCIPAL/);
  assert.equal(vcv("review", "approve", repo, "chg-a", "--digest", digest, "--key", key, "--trust-ref", "main", "--trust-commit", mainSha, "--as", "user:hoang").status, 2);
  const noAnchor = vcv("review", "approve", repo, "chg-a", "--digest", digest, "--key", key);
  assert.equal(noAnchor.status, 2);
  assert.match(noAnchor.stderr, /✗ INPUT: a trust anchor is required/);
  const localRef = vcv("review", "approve", repo, "chg-a", "--digest", digest, "--key", key, "--trust-ref", "main");
  assert.equal(localRef.status, 2);
  assert.match(localRef.stderr, /✗ UNPROTECTED_TRUST: .*main is a local ref/);
  const candidate = vcv("review", "approve", repo, "chg-a", "--digest", digest, "--key", key, "--trust-ref", "HEAD");
  assert.equal(candidate.status, 2);
  assert.match(candidate.stderr, /✗ UNPROTECTED_TRUST: .*HEAD names the checked-out HEAD/);
  const wrong = vcv("review", "approve", repo, "chg-a", "--digest", "0".repeat(64), "--key", key, "--trust-ref", "main", "--trust-commit", mainSha);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /✗ DIGEST_MISMATCH/);

  const ok = vcv("review", "approve", repo, "chg-a", "--digest", digest, "--key", key, "--trust-ref", "main", "--trust-commit", mainSha);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /chg-a: applied → rev-2-[0-9a-f]{12} \(proposed by agent:coder, approved by user:hoang/);
  assert.match(ok.stdout, /attestation: \.vcv\/approvals\/chg-a\.json/);
  assert.match(ok.stdout, /trust anchor: commit [0-9a-f]{12} pinned by the caller/);
  const again = vcv("review", "finalize", repo, "chg-a", "--digest", digest, "--key", key, "--trust-ref", "main", "--trust-commit", mainSha);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already present; unchanged/);

  const check = vcv("integrity", repo, "--base", "main", "--trust-ref", "main", "--require-attestation");
  assert.equal(check.status, 0, check.stdout);
  assert.match(check.stdout, /^integrity: ok/);
  assert.match(check.stdout, /approval attested \(signed by user:hoang/);
  const json = JSON.parse(vcv("integrity", repo, "--base", "main", "--json").stdout);
  assert.equal(json.ok, true);
  const selfTrust = vcv("integrity", repo, "--base", "main", "--trust-working-tree", "--require-attestation");
  assert.equal(selfTrust.status, 1, "strict mode rejects trust from the checkout");
  assert.match(selfTrust.stdout, /✗ TRUST_FROM_CHECKOUT/);

  const att = join(repo, ".vcv/approvals/chg-a.json");
  writeFileSync(att, readFileSync(att, "utf8").replace('"user:hoang"', '"user:mallory"'));
  const bad = vcv("integrity", repo, "--base", "main", "--trust-ref", "main", "--require-attestation");
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /^integrity: FAILED/);
  assert.match(bad.stdout, /✗ APPROVAL_INVALID/);
  assert.equal(vcv("integrity", repo, "--base", "main").status, 1, "an attestation that does not verify fails even without --require-attestation");
});

test("host gate: a candidate that rewrites its own vcv script, CLI and integrity code still fails a trusted gate with an invalid attestation, and passes once it is valid", async () => {
  const { baseline, git } = await import("../../../packages/repo/test/course-desk.ts");
  const { mkdirSync } = await import("node:fs");
  const ROOT = join(import.meta.dirname, "../../..");
  const GATE = join(ROOT, "scripts/vcv-host-gate.sh");
  const repo = baseline();
  const key = join(tmp(), "hoang.pem");
  assert.equal(vcv("reviewer", "init", key, "--id", "user:hoang", "--add", repo).status, 0);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "trust user:hoang");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "feature");
  const file = join(tmp(), "change.json");
  writeFileSync(file, JSON.stringify({ changeId: "chg-a", projectId: "prj-course-desk", expectedRevision: "rev-1", rationale: "x", operations: [{ type: "setDescription", objectId: "mod-web", description: "new" }] }));
  const agentEnv = { ...process.env, VCV_HOST_PRINCIPAL: "agent:coder", VCV_HOST_PERMISSIONS: "model:propose" };
  assert.equal(spawnSync("node", ["--experimental-strip-types", "--no-warnings", MAIN, "proposal", "submit", repo, file], { encoding: "utf8", env: agentEnv }).status, 0);
  const digest = JSON.parse(vcv("proposal", "preview", repo, "chg-a", "--json").stdout).data.proposal.proposalDigest as string;
  assert.equal(vcv("review", "approve", repo, "chg-a", "--digest", digest, "--key", key, "--trust-commit", base).status, 0);

  // The candidate forges its approval and rewrites everything a gate run inside it would execute.
  const att = join(repo, ".vcv/approvals/chg-a.json");
  const valid = readFileSync(att, "utf8");
  writeFileSync(att, valid.replace(/"signedAt": "[^"]+"/, '"signedAt": "2000-01-01T00:00:00.000Z"'));
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, vcv: "echo 'integrity: ok'", postinstall: "echo pwned" } }, null, 2));
  for (const rel of ["apps/cli/src/main.ts", "packages/repo/src/integrity.ts"]) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), 'console.log("integrity: ok"); process.exit(0);\n');
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "agent: approved, honestly");
  // What a gate that runs the candidate's own entry points would see:
  assert.equal(spawnSync("node", [join(repo, "apps/cli/src/main.ts")], { encoding: "utf8" }).stdout.trim(), "integrity: ok");

  const gate = (candidate: string, b = base) => spawnSync("bash", [GATE, ROOT, candidate, b], { encoding: "utf8" });
  const forged = gate(repo);
  assert.equal(forged.status, 1, forged.stdout + forged.stderr);
  assert.match(forged.stdout, /^integrity: FAILED/);
  assert.match(forged.stdout, /✗ APPROVAL_INVALID/);
  assert.match(forged.stdout, /trust: \.vcv\/reviewers\.json at [0-9a-f]{40} \([0-9a-f]{12}\), 1 reviewer\(s\); commit [0-9a-f]{12} pinned by the caller/);

  writeFileSync(att, valid);
  const ok = gate(repo);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /approval attested \(signed by user:hoang/);

  // Setup problems are refusals, never a pass.
  assert.equal(gate(repo, "main").status, 2, "the base must be a full commit ID");
  assert.equal(gate(repo, "0".repeat(40)).status, 2, "the base must be present in the candidate");
  assert.equal(spawnSync("bash", [GATE, repo, repo, base], { encoding: "utf8" }).status, 2, "the verifier must not come from the candidate");
});

test("handoff and implementation report through the CLI: JSON handoff, recorded report with warnings, show", async () => {
  const { baseline, git, edit, SERVICE } = await import("../../../packages/repo/test/course-desk.ts");
  const repo = baseline();
  const key = join(tmp(), "hoang.pem");
  assert.equal(vcv("reviewer", "init", key, "--id", "user:hoang", "--add", repo).status, 0);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "trust user:hoang");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "feature");
  const file = join(tmp(), "change.yaml");
  writeFileSync(file, [
    "changeId: chg-capacity",
    "projectId: prj-course-desk",
    "expectedRevision: rev-1",
    "rationale: tell students the capacity",
    "operations:",
    "  - { type: setRuleStatement, ruleId: rul-seat-limit, statement: \"A full course is rejected with COURSE_FULL and the capacity.\" }",
    "implementation:",
    "  behavior: A COURSE_FULL rejection reports the capacity.",
    "  acceptanceCriteria: [\"COURSE_FULL includes the capacity\"]",
    "  scope: [\"server/src/enrollment/**\"]",
    "",
  ].join("\n"));
  const agentEnv = { ...process.env, VCV_HOST_PRINCIPAL: "agent:coder", VCV_HOST_PERMISSIONS: "model:propose,binding:record" };
  const asAgent = (...args: string[]) => spawnSync("node", ["--experimental-strip-types", "--no-warnings", MAIN, ...args], { encoding: "utf8", env: agentEnv });
  assert.equal(asAgent("proposal", "submit", repo, file).status, 0);
  const preview = vcv("proposal", "preview", repo, "chg-capacity");
  assert.match(preview.stdout, /implementation requested \(approved together with the operations\):\n {2}behavior: A COURSE_FULL rejection reports the capacity\./);
  assert.match(preview.stdout, /scope: server\/src\/enrollment\/\*\*/);
  assert.equal(asAgent("handoff", repo, "chg-capacity").status, 1, "not before approval");
  const digest = JSON.parse(vcv("proposal", "preview", repo, "chg-capacity", "--json").stdout).data.proposal.proposalDigest as string;
  assert.equal(vcv("review", "approve", repo, "chg-capacity", "--digest", digest, "--key", key, "--trust-commit", base).status, 0);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "approved chg-capacity");

  const h = asAgent("handoff", repo, "chg-capacity");
  assert.equal(h.status, 0, h.stdout);
  const handoff = JSON.parse(h.stdout);
  assert.equal(handoff.kind, "vcv-implementation-handoff");
  assert.equal(asAgent("handoff", repo, "chg-capacity").stdout, h.stdout, "deterministic");

  edit(repo, SERVICE, "taken.length >= course.capacity", "taken.length >= course.capacity /* reported */");
  const reportFile = join(tmp(), "report.json");
  writeFileSync(reportFile, JSON.stringify({ changeId: "chg-capacity", baseCommit: handoff.git.baseCommit, handoffDigest: handoff.digest, testsRun: [{ command: "npm test -w server", outcome: "passed" }], acceptance: [{ criterion: "COURSE_FULL includes the capacity", status: "met" }], confidence: "high" }));
  const rec = asAgent("implementation", "record", repo, "--report", reportFile);
  assert.equal(rec.status, 0, rec.stdout + rec.stderr);
  assert.match(rec.stdout, /\.vcv\/implementations\/chg-capacity\.json: recorded \(digest [0-9a-f]{64}\)/);
  assert.match(rec.stdout, /claimed by agent:coder; not reconciled/);
  assert.match(rec.stdout, /1 source file\(s\) changed since [0-9a-f]{12}, 0 outside the approved scope; 0\/\d+ affected binding\(s\) reasserted/);
  assert.match(rec.stdout, /! BINDING_NOT_REASSERTED: impl\.rul-seat-limit/);
  assert.match(rec.stdout, /! CLAIMS_UNVERIFIED/);
  assert.match(asAgent("implementation", "record", repo, "--report", reportFile).stdout, /✗ REPORT_EXISTS/);
  const show = vcv("implementation", "show", repo, "chg-capacity");
  assert.equal(show.status, 0, show.stdout);
  assert.match(show.stdout, /same as recorded/);
});
