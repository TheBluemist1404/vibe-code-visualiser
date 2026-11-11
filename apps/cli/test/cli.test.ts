// The CLI as an agent uses it during bootstrap (Issue #11): validate → project init → status,
// with readable diagnostics instead of stack traces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
