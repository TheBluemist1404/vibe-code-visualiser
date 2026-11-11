// The M2.2 reference app materializes as an unknown, standalone repository (Issue #9).
// The app's own install/build/test/smoke run is examples/reference-app/check.sh (CI job
// "reference-app"); this test covers the repository contract without installing anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectStatus, resolveProjectRoot } from "../src/index.ts";

const APP = join(import.meta.dirname, "../../../examples/reference-app");
const materialize = (dest: string) => execFileSync("bash", [join(APP, "materialize.sh"), dest], { encoding: "utf8" }).trim();
/** Committed files that mention any of `words` (case-insensitive, whole words). git grep exits 1 for no match. */
function gitGrep(cwd: string, ...words: string[]): string[] {
  const args = ["-C", cwd, "grep", "-ilw", ...words.flatMap((w) => ["-e", w]), "HEAD", "--", ".", ":!package-lock.json"];
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim().split("\n");
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("the reference app materializes as its own Git repository with a clean baseline and no project", () => {
  const dest = join(realpathSync(mkdtempSync(join(tmpdir(), "vcv-refapp-"))), "course-desk");
  const commit = materialize(dest);

  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(git(dest, "rev-parse", "HEAD"), commit, "the printed commit is the baseline");
  assert.equal(git(dest, "rev-list", "--count", "HEAD"), "1");
  assert.equal(git(dest, "status", "--porcelain"), "", "nothing uncommitted");
  assert.deepEqual(resolveProjectRoot(join(dest, "server", "src")), { root: dest, isGit: true }, "its own working-tree root, not the VCV monorepo");

  const files = git(dest, "ls-files").split("\n");
  for (const f of ["package.json", "package-lock.json", "server/src/enrollment/enrollment.service.ts", "server/src/notifications/notifications.service.ts", "web/src/App.tsx", "scripts/smoke.mjs"]) {
    assert.ok(files.includes(f), `${f} is committed`);
  }
  assert.ok(!files.some((f) => /(^|\/)(node_modules|dist|\.vcv)\//.test(f)), "no dependencies, build output or .vcv/");
  // The oracle is evaluation data and the app must look unknown: no answer key, no VCV hints.
  assert.ok(!files.some((f) => /oracle/i.test(f)));
  assert.ok(gitGrep(dest, "NotificationsService").includes("HEAD:server/src/enrollment/enrollment.service.ts"), "the search itself works");
  assert.deepEqual(gitGrep(dest, "vcv", "oracle"), [], "(package-lock.json is skipped: integrity hashes are random text)");

  const status = projectStatus(dest);
  assert.equal(status.state, "absent");
  assert.equal(status.root, dest);
  assert.equal(status.git!.commit, commit);
  assert.equal(status.git!.dirty, false);
  assert.ok(!existsSync(join(dest, ".vcv")), "looking does not create a project");
});

test("the baseline commit is reproducible from the template", () => {
  const a = materialize(join(mkdtempSync(join(tmpdir(), "vcv-refapp-")), "a"));
  const b = materialize(join(mkdtempSync(join(tmpdir(), "vcv-refapp-")), "b"));
  assert.equal(a, b);
});

test("materialize refuses a non-empty destination", () => {
  const dest = mkdtempSync(join(tmpdir(), "vcv-refapp-"));
  materialize(join(dest, "x"));
  assert.throws(() => execFileSync("bash", [join(APP, "materialize.sh"), join(dest, "x")], { stdio: "pipe" }));
  assert.equal(readFileSync(join(dest, "x", "README.md"), "utf8").split("\n")[0], "# Course Desk");
});
