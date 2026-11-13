// Agent-led model maintenance (Issue #15, M2.5): the generic guide and prompt, the controlled
// change setup, the host-fixed agent identity, and the recorded run's proposal replayed through
// VCV's supported operations. The agent run itself is
// examples/reference-app/maintenance/run-agent.sh (needs a signed-in `claude`); this test needs
// neither the agent nor npm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidenceApi } from "../src/index.ts";

const ROOT = join(import.meta.dirname, "../../..");
const GUIDE = join(ROOT, "docs/agent-maintenance.md");
const HERE = join(ROOT, "examples/reference-app/maintenance");
const RUN = join(ROOT, "docs/samples/m2.5-maintenance");
const CLI = join(ROOT, "apps/cli/src/main.ts");
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vcv-maint-")));
const FIXTURE_TERMS =
  /\b(courses?|enrol\w*|students?|seats?|notif\w*|nest(js)?|react|vite|poetry|algebra|outbox|catalog|waitlist\w*)\b/i;

/** The CLI as the agent's wrapper runs it: identity and permissions fixed by the host. */
const asAgent = (args: string[], cwd?: string) =>
  spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, VCV_HOST_PRINCIPAL: "agent:maintainer", VCV_HOST_PERMISSIONS: "model:propose" },
  });

let prepared: string | undefined;
/** setup.sh output, made once (materialize + eight claims + the patch). Tests copy it. */
function setup(): string {
  if (!prepared) {
    prepared = join(tmp(), "course-desk");
    execFileSync("bash", [join(HERE, "setup.sh"), prepared], { encoding: "utf8" });
  }
  const copy = join(tmp(), "course-desk");
  execFileSync("cp", ["-a", prepared, copy]);
  return copy;
}

test("the maintenance guide and prompt are general: no fixture-specific answers", () => {
  for (const file of [GUIDE, join(HERE, "prompt.md")]) {
    const text = readFileSync(file, "utf8");
    const hit = text.match(FIXTURE_TERMS);
    assert.equal(hit, null, `${file} mentions "${hit?.[0]}"`);
  }
});

test("the maintenance toolkit carries the maintenance guide and nothing about the fixture", () => {
  const dest = join(tmp(), "vcv");
  execFileSync("bash", [join(ROOT, "examples/reference-app/bootstrap/toolkit.sh"), dest, GUIDE], { encoding: "utf8" });
  assert.equal(readFileSync(join(dest, "AGENT_GUIDE.md"), "utf8"), readFileSync(GUIDE, "utf8"));
  const grep = spawnSync("grep", ["-rIliE", "oracle|course desk|enrol|waitlist", dest, "--exclude-dir=node_modules"], {
    encoding: "utf8",
  });
  assert.equal(grep.status, 1, `grep found: ${grep.stdout}`);
});

test("setup: a committed baseline with eight claims, then the uncommitted waitlist change makes the expected claims stale or missing", () => {
  const repo = setup();
  const log = execFileSync("git", ["-C", repo, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(log, ["vcv: draft model and binding claims", "Course Desk baseline"]);
  const r = createEvidenceApi(repo).getEvidenceOverview();
  assert.ok(r.ok);
  assert.equal(r.context.observed.dirty, true);
  assert.deepEqual(Object.fromEntries(r.data.bindings.map((b) => [b.bindingId, b.state])), {
    "expose.cap-enroll": "resolved",
    "impl.cap-enroll": "stale",
    "impl.cap-list-courses": "resolved",
    "impl.rul-no-double-enroll": "stale",
    "impl.rul-seat-limit": "stale",
    "persist.dat-enrollment": "stale",
    "persist.dat-notification": "stale",
    "test.rul-seat-limit": "missing",
  });
});

test("a host-fixed agent identity can propose but never apply or approve, and cannot widen itself with flags", () => {
  const repo = setup();
  const dir = join(repo, "vcv-maintenance");
  execFileSync("mkdir", ["-p", dir]);
  const change = join(dir, "change.yaml");
  execFileSync("bash", ["-c", 'cat > "$1"', "_", change], {
    input:
      "changeId: ch-test-01\nprojectId: prj-course-desk\nexpectedRevision: rev-1\nrationale: test\noperations:\n  - { type: setRuleStatement, ruleId: rul-seat-limit, statement: A full course takes requests onto a waitlist. }\n",
  });
  const p = asAgent(["propose", join(repo, ".vcv"), change]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /ch-test-01: pending \(proposed by agent:maintainer; record is pending\)/);
  assert.match(asAgent(["approve", join(repo, ".vcv"), "ch-test-01"]).stdout, /denied/);
  for (const flags of [
    ["--perm", "propose,apply,approve"],
    ["--as", "user:hoang"],
  ]) {
    const r = asAgent(["approve", join(repo, ".vcv"), "ch-test-01", ...flags]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /fixed by this host/);
  }
  assert.match(asAgent(["show", join(repo, ".vcv")]).stdout, /rev-1 \[draft\]/);
});

test("the recorded agent proposal replays as a validated pending change on a fresh setup; evidence is unchanged by it", {
  skip: !existsSync(join(RUN, "change-records")),
}, () => {
  const records = readdirSync(join(RUN, "change-records")).filter((f) => f.endsWith(".json"));
  assert.equal(records.length, 1, "one proposal");
  const record = JSON.parse(readFileSync(join(RUN, "change-records", records[0]!), "utf8"));
  assert.equal(record.status, "pending");
  assert.equal(record.proposerId, "agent:maintainer");
  assert.equal(record.approverId, undefined);
  const repo = setup();
  const before = JSON.stringify(createEvidenceApi(repo).refreshEvidence());
  // Resubmit exactly the change the agent submitted.
  const file = join(repo, "replay.json");
  execFileSync("bash", ["-c", 'cat > "$1"', "_", file], { input: JSON.stringify(record.change) });
  const p = asAgent(["propose", join(repo, ".vcv"), file]);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /: pending /);
  assert.doesNotMatch(p.stdout, /✗/);
  assert.equal(
    JSON.stringify(createEvidenceApi(repo).refreshEvidence()),
    before,
    "a pending proposal changes no evidence",
  );
});
