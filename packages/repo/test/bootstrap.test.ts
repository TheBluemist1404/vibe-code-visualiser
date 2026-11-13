// Agent-led bootstrap (Issue #11, M2.3): the generic guide and toolkit an agent gets, and the
// recorded run's draft replayed through VCV's supported operations. The agent run itself is
// examples/reference-app/bootstrap/run-agent.sh (needs a signed-in `claude`); this test needs
// neither the agent nor npm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModel, loadModel, parseYaml } from "@vcv/ir";
import { FileStoreReader } from "@vcv/core";
import { createQueryApi } from "@vcv/query";
import { RepositoryProject, initProject, projectStatus } from "../src/index.ts";

const ROOT = join(import.meta.dirname, "../../..");
const GUIDE = join(ROOT, "docs/agent-bootstrap.md");
const BOOTSTRAP = join(ROOT, "examples/reference-app/bootstrap");
const RUN = join(ROOT, "docs/samples/m2.3-bootstrap");
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vcv-bootstrap-")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** Words that would tell an agent what the fixture app contains. */
const FIXTURE_TERMS =
  /\b(courses?|enrol\w*|students?|seats?|notif\w*|nest(js)?|react|vite|poetry|algebra|outbox|catalog)\b/i;

test("the bootstrap guide and prompt are general: no fixture-specific answers", () => {
  for (const file of [GUIDE, join(BOOTSTRAP, "prompt.md")]) {
    const text = readFileSync(file, "utf8");
    const hit = text.match(FIXTURE_TERMS);
    assert.equal(hit, null, `${file} mentions "${hit?.[0]}"`);
  }
});

test("the guide's example model is valid and creates a ready draft project through project init", () => {
  const yaml = readFileSync(GUIDE, "utf8").match(/```yaml\n([\s\S]*?)```/)![1]!;
  const checked = checkModel(parseYaml(yaml));
  assert.ok(checked.ok, JSON.stringify(checked.diagnostics));
  assert.equal(checked.model!.project.status, "draft");

  const repo = tmp();
  git(repo, "init", "-q");
  const status = initProject(repo, checked.model!);
  assert.equal(status.state, "ready");
  assert.equal(status.model!.status, "draft");
});

test("the agent toolkit holds the engine and the guide, but no examples, tests, ADRs or oracle", () => {
  const dest = join(tmp(), "vcv");
  execFileSync("bash", [join(BOOTSTRAP, "toolkit.sh"), dest], { encoding: "utf8" });
  assert.equal(readFileSync(join(dest, "AGENT_GUIDE.md"), "utf8"), readFileSync(GUIDE, "utf8"));
  assert.deepEqual(readdirSync(dest).sort(), [
    "AGENT_GUIDE.md",
    "apps",
    "bin",
    "node_modules",
    "package.json",
    "packages",
  ]);
  for (const p of readdirSync(join(dest, "packages"))) {
    const own = existsSync(join(ROOT, "packages", p, "node_modules")) ? ["node_modules"] : [];
    assert.deepEqual(readdirSync(join(dest, "packages", p)).sort(), [...own, "package.json", "src"]);
  }
  assert.deepEqual(readdirSync(join(dest, "apps")), ["cli"]);
  // Nothing outside node_modules mentions the fixture or the oracle.
  const grep = spawnSync("grep", ["-rIliE", "oracle|course desk|enrol", dest, "--exclude-dir=node_modules"], {
    encoding: "utf8",
  });
  assert.equal(grep.status, 1, `grep found: ${grep.stdout}`); // 1 = no match
});

test("the toolkit's vcv command validates a model from any directory", () => {
  const dest = join(tmp(), "vcv");
  execFileSync("bash", [join(BOOTSTRAP, "toolkit.sh"), dest]);
  const yaml = readFileSync(GUIDE, "utf8").match(/```yaml\n([\s\S]*?)```/)![1]!;
  const dir = tmp();
  const file = join(dir, "model.yaml");
  execFileSync("bash", ["-c", 'cat > "$1"', "_", file], { input: yaml });
  assert.match(execFileSync(join(dest, "bin/vcv"), ["validate", file], { cwd: dir, encoding: "utf8" }), /: valid/);
});

test("the recorded agent draft replays into a ready, queryable draft project on a fresh Course Desk checkout", () => {
  const recorded = readFileSync(join(RUN, "agent-output/model.yaml"), "utf8");
  const loaded = loadModel(recorded);
  assert.ok(loaded.ok, JSON.stringify(loaded.diagnostics));
  assert.equal(loaded.model!.project.status, "draft");

  const repo = join(tmp(), "course-desk");
  const baseline = execFileSync("bash", [join(ROOT, "examples/reference-app/materialize.sh"), repo], {
    encoding: "utf8",
  }).trim();
  assert.equal(projectStatus(repo).state, "absent");
  // The same supported operation the agent used (`vcv project init`), never a hand-written .vcv/.
  const out = execFileSync(
    "node",
    [
      "--experimental-strip-types",
      "--no-warnings",
      join(ROOT, "apps/cli/src/main.ts"),
      "project",
      "init",
      repo,
      join(RUN, "agent-output/model.yaml"),
    ],
    { encoding: "utf8" },
  );
  assert.match(out, /project: ready/);

  // Reopen from scratch, as after a restart, and query through the existing APIs.
  const project = RepositoryProject.open(repo);
  const st = project.status();
  assert.equal(st.state, "ready");
  assert.equal(st.model!.status, "draft");
  assert.equal(st.model!.revision, "rev-1");
  assert.equal(st.git!.commit, baseline, "the code is untouched: still at the baseline commit");
  const overview = createQueryApi(new FileStoreReader(join(repo, ".vcv"))).getProjectOverview();
  assert.ok(overview.ok);
  assert.equal(overview.context.snapshotStatus, "draft");
  assert.equal(overview.context.implementationChecked, false, "model only: nothing here is verified against code");
  assert.ok(overview.data.modules.length >= 2);
  // Only .vcv/ is new; the model lives where Git would commit it.
  assert.deepEqual(git(repo, "status", "--porcelain", "--untracked-files=normal").split("\n"), ["?? .vcv/"]);
  assert.ok(existsSync(join(repo, ".vcv", "HEAD")));
});
