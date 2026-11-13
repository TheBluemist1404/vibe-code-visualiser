// Repository-native project loading against real Git checkouts (Issue #6, M2.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { dumpModel, loadModel, parseYaml } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import { FileStore, ModelEngine, StoreError } from "@vcv/core";
import type { HostContext, ModelStore, ProposedModelChange } from "@vcv/core";
import { createQueryApi } from "@vcv/query";
import {
  RepositoryProject,
  ProjectError,
  VCV_DIR,
  compareLines,
  initProject,
  parsePorcelainZ,
  projectStatus,
} from "../src/index.ts";

const FIXTURES = join(import.meta.dirname, "../../../examples/enrollment");
const baseModel = (): Model => loadModel(readFileSync(join(FIXTURES, "model.rev-1.yaml"), "utf8")).model!;
const timeoutChange = () =>
  parseYaml(readFileSync(join(FIXTURES, "change.timeout.yaml"), "utf8")) as ProposedModelChange;
const owner: HostContext = {
  principalId: "user:hoang",
  permissions: ["model:propose", "model:apply", "model:approve"],
};
const rename = (changeId: string, expectedRevision: string, name: string): ProposedModelChange => ({
  changeId,
  projectId: "prj-lms",
  expectedRevision,
  operations: [{ type: "renameState", behaviorId: "beh-enrollment-approval", stateId: "st-pending", name }],
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "VCV Test",
  GIT_AUTHOR_EMAIL: "vcv-test@example.invalid",
  GIT_COMMITTER_NAME: "VCV Test",
  GIT_COMMITTER_EMAIL: "vcv-test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function tryGit(cwd: string, ...args: string[]): boolean {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

/** A Git repo with some source and a committed .vcv/ project at rev-1. */
function repoWithProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "vcv-repo-"));
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "enrollment.ts"), "export const reject = () => 'rejected';\n");
  initProject(dir, baseModel());
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init vcv project");
  return dir;
}
const engineFor = (repo: string) => new ModelEngine(new FileStore(join(repo, VCV_DIR)));
const commitAll = (repo: string, msg: string) => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
};

function snapshot(dir: string): string {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true })
      .filter((e) => e.name !== ".git")
      .flatMap((e) => (e.isDirectory() ? [`${join(d, e.name)}/`, ...walk(join(d, e.name))] : [join(d, e.name)]));
  return walk(dir)
    .sort()
    .map((f) => (f.endsWith("/") ? f : `${f}:${statSync(f).mtimeMs}:${readFileSync(f, "utf8").length}`))
    .join("\n");
}

test("a checkout without .vcv/ is reported as absent, and nothing is created", () => {
  const dir = mkdtempSync(join(tmpdir(), "vcv-repo-"));
  git(dir, "init", "-q", "-b", "main");
  const s = projectStatus(dir);
  assert.equal(s.state, "absent");
  assert.equal(s.diagnostics[0]!.code, "NO_PROJECT");
  assert.deepEqual(readdirSync(dir), [".git"], "no invented model");
  assert.throws(
    () => RepositoryProject.open(dir),
    (e: unknown) => e instanceof ProjectError && e.status.state === "absent",
  );

  mkdirSync(join(dir, VCV_DIR));
  assert.equal(projectStatus(dir).state, "uninitialized");
});

test("opening from a subdirectory finds the project at the repository root and records Git context", () => {
  const repo = repoWithProject();
  const s = projectStatus(join(repo, "src"));
  assert.equal(s.state, "ready");
  assert.equal(s.root, repo);
  assert.equal(s.git!.branch, "main");
  assert.equal(s.git!.commit, git(repo, "rev-parse", "HEAD"));
  assert.equal(s.git!.dirty, false);
  assert.equal(s.model!.revision, "rev-1");
  assert.deepEqual(s.diagnostics, []);
  // The local-only files are ignored by Git, so a write does not make the checkout look dirty
  // except for the model files it really changed.
  assert.ok(readFileSync(join(repo, VCV_DIR, ".gitignore"), "utf8").includes("audit.jsonl"));
});

test("loading and querying do not write anything to the checkout", () => {
  const repo = repoWithProject();
  const before = snapshot(repo);
  const status = git(repo, "status", "--porcelain");
  const p = RepositoryProject.open(repo);
  const q = createQueryApi(p.reader);
  assert.ok(q.getProjectOverview().ok);
  p.refresh();
  projectStatus(repo);
  assert.equal(snapshot(repo), before);
  assert.equal(git(repo, "status", "--porcelain"), status);
});

test("the same repo cloned into two paths resolves the same model; .vcv/ holds no absolute paths", () => {
  const origin = repoWithProject();
  const e = engineFor(origin);
  assert.equal(e.propose(timeoutChange(), owner).status, "applied");
  commitAll(origin, "model: timeout");

  const parent = mkdtempSync(join(tmpdir(), "vcv-clones-"));
  const one = join(parent, "one");
  const two = join(parent, "deeper", "path", "two");
  git(parent, "clone", "-q", origin, one);
  mkdirSync(join(parent, "deeper", "path"), { recursive: true });
  git(parent, "clone", "-q", origin, two);

  const [a, b] = [one, two].map((d) => RepositoryProject.open(d));
  assert.equal(a!.reader.current().project.modelRevision, b!.reader.current().project.modelRevision);
  assert.deepEqual(a!.reader.current(), b!.reader.current());
  assert.equal(a!.status().git!.commit, b!.status().git!.commit);

  for (const root of [origin, one, two]) {
    const files = readdirSync(join(root, VCV_DIR), { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
    for (const f of files) {
      const text = readFileSync(join(f.parentPath, f.name), "utf8");
      for (const abs of [origin, one, two, tmpdir()])
        assert.ok(!text.includes(abs), `${relative(root, join(f.parentPath, f.name))} mentions ${abs}`);
    }
  }
});

test("uncommitted model changes are observation context, not a different model", () => {
  const repo = repoWithProject();
  engineFor(repo).propose(timeoutChange(), owner);
  const s = projectStatus(repo);
  assert.equal(s.state, "ready");
  assert.equal(s.git!.dirty, true);
  assert.ok(s.git!.storeChanges.includes(`${VCV_DIR}/HEAD`));
  assert.ok(
    s.git!.storeChanges.every((p) => !p.includes("audit.jsonl")),
    "the local audit log is git-ignored",
  );
  assert.ok(s.diagnostics.some((d) => d.code === "UNCOMMITTED_MODEL_CHANGES"));
});

test("switching branches: refresh reports a different model line; nothing is reset or rewritten", () => {
  const repo = repoWithProject();
  git(repo, "checkout", "-q", "-b", "feature-a");
  const ra = engineFor(repo).propose(rename("ch-a", "rev-1", "Waiting (A)"), owner);
  commitAll(repo, "model: A");
  git(repo, "checkout", "-q", "main");
  git(repo, "checkout", "-q", "-b", "feature-b");
  const rb = engineFor(repo).propose(rename("ch-b", "rev-1", "Waiting (B)"), owner);
  commitAll(repo, "model: B");
  const revA = ra.record!.resultingRevision!;
  const revB = rb.record!.resultingRevision!;
  assert.notEqual(revA, revB, "branch-safe IDs: both are the second revision, but not the same ID");

  const p = RepositoryProject.open(repo);
  assert.equal(p.reader.current().project.modelRevision, revB);

  git(repo, "checkout", "-q", "feature-a");
  const r = p.refresh();
  assert.equal(r.modelLine, "switched");
  assert.ok(r.branchChanged && r.gitCommitChanged);
  assert.equal(
    p.reader.current().project.modelRevision,
    revA,
    "the reader follows the checkout; no stale model is served",
  );
  assert.equal(p.reader.current().behaviors[0]!.states.find((s) => s.id === "st-pending")!.name, "Waiting (A)");

  git(repo, "checkout", "-q", "main");
  assert.equal(p.refresh().modelLine, "rewound");
  git(repo, "checkout", "-q", "feature-a");
  assert.equal(p.refresh().modelLine, "advanced");
  assert.equal(p.refresh().modelLine, "unchanged");
  assert.equal(git(repo, "status", "--porcelain"), "", "observing never touched the working tree");
});

test("merging two diverged model branches is detected (conflict, then foreign history); no silent merge", () => {
  const repo = repoWithProject();
  git(repo, "checkout", "-q", "-b", "feature-a");
  const revA = engineFor(repo).propose(rename("ch-a", "rev-1", "Waiting (A)"), owner).record!.resultingRevision!;
  commitAll(repo, "model: A");
  git(repo, "checkout", "-q", "main");
  git(repo, "checkout", "-q", "-b", "feature-b");
  const revB = engineFor(repo).propose(rename("ch-b", "rev-1", "Waiting (B)"), owner).record!.resultingRevision!;
  commitAll(repo, "model: B");

  // Revision files have distinct names, so only HEAD conflicts.
  assert.equal(tryGit(repo, "merge", "-q", "feature-a"), false, "the merge stops on .vcv/HEAD");
  const conflicted = projectStatus(repo);
  assert.equal(conflicted.state, "conflicted");
  assert.ok(conflicted.diagnostics.some((d) => d.code === "CONFLICTED" && d.message.includes(`${VCV_DIR}/HEAD`)));
  assert.equal(conflicted.git!.operation, "merge");
  assert.throws(
    () => new FileStore(join(repo, VCV_DIR)),
    (e: unknown) => e instanceof StoreError && e.code === "CONFLICTED",
  );
  assert.throws(() => RepositoryProject.open(repo), ProjectError);

  // Resolving by taking our HEAD keeps A's revision file around: that is detected, not dropped.
  git(repo, "checkout", "--ours", "--", `${VCV_DIR}/HEAD`);
  const diverged = projectStatus(repo);
  assert.equal(diverged.state, "diverged");
  assert.equal(diverged.model!.revision, revB);
  assert.ok(diverged.inspection.state === "diverged" && diverged.inspection.foreign.some((f) => f.id === revA));
  assert.throws(
    () => new FileStore(join(repo, VCV_DIR)),
    (e: unknown) => e instanceof StoreError && e.code === "DIVERGED",
  );
  assert.ok(
    readdirSync(join(repo, VCV_DIR, "revisions")).includes(`${revA}.yaml`),
    "the other branch's revision was not moved",
  );

  // Backing out of the merge restores a clean, ready project at B.
  git(repo, "merge", "--abort");
  const after = projectStatus(repo);
  assert.equal(after.state, "ready");
  assert.equal(after.model!.revision, revB);
});

test("merging diverged branches and resolving .vcv/HEAD to the common ancestor keeps both branch revisions (PR #8 review)", () => {
  const repo = repoWithProject();
  git(repo, "checkout", "-q", "-b", "feature-a");
  const revA = engineFor(repo).propose(rename("ch-a", "rev-1", "Waiting (A)"), owner).record!.resultingRevision!;
  commitAll(repo, "model: A");
  git(repo, "checkout", "-q", "main");
  git(repo, "checkout", "-q", "-b", "feature-b");
  const revB = engineFor(repo).propose(rename("ch-b", "rev-1", "Waiting (B)"), owner).record!.resultingRevision!;
  commitAll(repo, "model: B");

  assert.equal(tryGit(repo, "merge", "-q", "feature-a"), false);
  // Resolve HEAD to main's version (rev-1): both rev-2 files now verify as "children of HEAD".
  writeFileSync(join(repo, VCV_DIR, "HEAD"), `${git(repo, "show", `main:${VCV_DIR}/HEAD`)}\n`);
  git(repo, "add", `${VCV_DIR}/HEAD`);
  git(repo, "commit", "-q", "-m", "merge, model reset to ancestor");

  const s = projectStatus(repo);
  assert.equal(s.state, "diverged");
  assert.equal(s.model!.revision, "rev-1");
  assert.ok(
    s.inspection.state === "diverged" &&
      [revA, revB].every((r) => s.inspection.state === "diverged" && s.inspection.foreign.some((f) => f.id === r)),
  );
  assert.throws(
    () => new FileStore(join(repo, VCV_DIR)),
    (e: unknown) => e instanceof StoreError && e.code === "DIVERGED",
  );
  const files = readdirSync(join(repo, VCV_DIR, "revisions"));
  assert.ok(files.includes(`${revA}.yaml`) && files.includes(`${revB}.yaml`), "neither branch revision was orphaned");
  assert.equal(git(repo, "status", "--porcelain"), "", "nothing in the checkout changed");
});

test("a writer left open across `git checkout` cannot overwrite the checked-out branch's model (PR #8 review, P1)", () => {
  const repo = repoWithProject();
  git(repo, "checkout", "-q", "-b", "feature-b");
  const revB = engineFor(repo).propose(rename("ch-b", "rev-1", "Waiting (B)"), owner).record!.resultingRevision!;
  commitAll(repo, "model: B");
  git(repo, "checkout", "-q", "main");

  const store = new FileStore(join(repo, VCV_DIR));
  const e = new ModelEngine(store); // long-lived writer, opened on main at rev-1
  assert.equal(e.current().project.modelRevision, "rev-1");
  git(repo, "checkout", "-q", "feature-b");

  const stale = e.propose(rename("ch-old-line", "rev-1", "Waiting (main)"), owner);
  assert.equal(stale.status, "rejected");
  assert.equal(stale.diagnostics[0]!.code, "STALE_REVISION");
  assert.equal(projectStatus(repo).model!.revision, revB);
  assert.equal(git(repo, "diff", "--", `${VCV_DIR}/HEAD`), "", "feature-b's HEAD was not overwritten");

  const ok = e.propose(rename("ch-on-b", revB, "Waiting (B2)"), owner);
  assert.equal(ok.status, "applied");
  assert.deepEqual(projectStatus(repo).model!.history.slice(0, 2), ["rev-1", revB]);
});

test("a long-lived reader follows a branch whose initial rev-1 is a different model (PR #8 review, round 3)", () => {
  const repo = repoWithProject();
  git(repo, "checkout", "-q", "-b", "other-init");
  // Another branch initialized its own project: same ID rev-1, different content.
  const other = baseModel();
  other.project.name = "LMS (other branch)";
  writeFileSync(join(repo, VCV_DIR, "revisions", "rev-1.yaml"), dumpModel(other));
  commitAll(repo, "re-init model");
  git(repo, "checkout", "-q", "main");

  const p = RepositoryProject.open(repo);
  const q = createQueryApi(p.reader);
  const name = () => {
    const r = q.getProjectOverview();
    assert.ok(r.ok);
    return r.data.project.name;
  };
  assert.equal(name(), "LMS");
  git(repo, "checkout", "-q", "other-init");
  assert.equal(name(), "LMS (other branch)", "the reader does not serve the cached model of the previous branch");
  const r = p.refresh();
  assert.equal(r.modelLine, "switched", "same revision IDs, different content");
  git(repo, "checkout", "-q", "main");
  assert.equal(name(), "LMS");
});

test("a writer that rejected a diverged checkout keeps rejecting it on later calls (real Git, round 3)", () => {
  const repo = repoWithProject();
  git(repo, "checkout", "-q", "-b", "feature-a");
  const revA = engineFor(repo).propose(rename("ch-a", "rev-1", "Waiting (A)"), owner).record!.resultingRevision!;
  commitAll(repo, "model: A");
  git(repo, "checkout", "-q", "main");
  git(repo, "checkout", "-q", "-b", "feature-b");
  engineFor(repo).propose(rename("ch-b", "rev-1", "Waiting (B)"), owner);
  commitAll(repo, "model: B");
  // A merge commit whose .vcv/HEAD was resolved to the common ancestor.
  git(repo, "checkout", "-q", "-b", "bad-merge");
  assert.equal(tryGit(repo, "merge", "-q", "feature-a"), false);
  writeFileSync(join(repo, VCV_DIR, "HEAD"), `${git(repo, "show", `main:${VCV_DIR}/HEAD`)}\n`);
  commitAll(repo, "merge, model reset to ancestor");
  git(repo, "checkout", "-q", "feature-a");

  const e = new ModelEngine(new FileStore(join(repo, VCV_DIR))); // opened on a healthy branch
  assert.equal(e.current().project.modelRevision, revA);
  git(repo, "checkout", "-q", "bad-merge");
  for (let i = 0; i < 2; i++)
    assert.throws(
      () => e.current(),
      (err: unknown) => err instanceof StoreError && err.code === "DIVERGED",
    );
  assert.throws(
    () => e.propose(rename("ch-x", "rev-1", "x"), owner),
    (err: unknown) => err instanceof StoreError && err.code === "DIVERGED",
  );
  assert.equal(git(repo, "status", "--porcelain"), "", "HEAD, revisions and records untouched");
});

test("an open writer and reader survive a merge resolved to their own unchanged HEAD: DIVERGED until resolved (PR #8 review, round 4)", () => {
  const repo = repoWithProject();
  git(repo, "checkout", "-q", "-b", "feature-a");
  const revA = engineFor(repo).propose(rename("ch-a", "rev-1", "Waiting (A)"), owner).record!.resultingRevision!;
  commitAll(repo, "model: A");
  git(repo, "checkout", "-q", "main");
  git(repo, "checkout", "-q", "-b", "feature-b");
  const revB = engineFor(repo).propose(rename("ch-b", "rev-1", "Waiting (B)"), owner).record!.resultingRevision!;
  commitAll(repo, "model: B");

  const e = new ModelEngine(new FileStore(join(repo, VCV_DIR))); // long-lived writer at revB
  const p = RepositoryProject.open(repo); // long-lived reader at revB
  const q = createQueryApi(p.reader);
  assert.equal(e.current().project.modelRevision, revB);
  assert.ok(q.getProjectOverview().ok);
  const headBytes = readFileSync(join(repo, VCV_DIR, "HEAD"), "utf8");

  assert.equal(tryGit(repo, "merge", "-q", "feature-a"), false);
  git(repo, "checkout", "--ours", "--", `${VCV_DIR}/HEAD`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "merge feature-a, keep our model HEAD");
  assert.equal(readFileSync(join(repo, VCV_DIR, "HEAD"), "utf8"), headBytes, "HEAD bytes are exactly revB's");
  assert.equal(projectStatus(repo).state, "diverged");

  const diverged = (err: unknown) => err instanceof StoreError && err.code === "DIVERGED";
  for (let i = 0; i < 2; i++) {
    assert.throws(() => e.current(), diverged, `writer read ${i + 1}`);
    assert.throws(() => p.reader.current(), diverged, `reader read ${i + 1}`);
  }
  assert.throws(() => e.propose(rename("ch-c", revB, "Waiting (C)"), owner), diverged);
  assert.equal(git(repo, "status", "--porcelain"), "", "HEAD untouched, no file relocated, no record written");
  assert.ok(readdirSync(join(repo, VCV_DIR, "revisions")).includes(`${revA}.yaml`));

  // Manual resolution: drop the other line's revision and record. Both handles recover.
  git(repo, "rm", "-q", `${VCV_DIR}/revisions/${revA}.yaml`, `${VCV_DIR}/changes/ch-a.json`);
  git(repo, "commit", "-q", "-m", "keep B's model line");
  assert.equal(p.reader.current().project.modelRevision, revB);
  assert.equal(e.propose(rename("ch-c", revB, "Waiting (C)"), owner).status, "applied");
});

test("a git checkout landing between the engine's dry-run and its commit is refused (PR #8 review, round 5)", () => {
  const repo = repoWithProject();
  git(repo, "checkout", "-q", "-b", "feature-b");
  engineFor(repo).propose(rename("ch-b", "rev-1", "Waiting (B)"), owner);
  commitAll(repo, "model: B");
  git(repo, "checkout", "-q", "main");

  const inner = new FileStore(join(repo, VCV_DIR));
  let fired = false;
  // Delegate everything; run the checkout once, right after the engine took its snapshot.
  const racing: ModelStore = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "snapshot" || typeof v !== "function") return typeof v === "function" ? v.bind(target) : v;
      return () => {
        const snap = v.call(target);
        if (!fired) {
          fired = true;
          git(repo, "checkout", "-q", "feature-b");
        }
        return snap;
      };
    },
  });
  const r = new ModelEngine(racing).propose(rename("ch-main", "rev-1", "Waiting (main)"), owner);
  assert.equal(r.status, "rejected");
  assert.ok(["HEAD_CHANGED", "STORE_CHANGED"].includes(r.diagnostics[0]!.code));
  assert.equal(git(repo, "status", "--porcelain"), "", "feature-b's HEAD, revisions and records untouched");
});

/** A FileStore on `repo` that checks out `branch` once, right after `method` returns its result. */
function racingAfter(repo: string, method: "snapshot" | "getChange", branch: string): ModelStore {
  const inner = new FileStore(join(repo, VCV_DIR));
  let fired = false;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== method || typeof v !== "function") return typeof v === "function" ? v.bind(target) : v;
      return (...args: unknown[]) => {
        const result = v.apply(target, args);
        if (!fired) {
          fired = true;
          git(repo, "checkout", "-q", branch);
        }
        return result;
      };
    },
  });
}

test("a proposal record is never written into another branch after a checkout (PR #8 review, round 6)", () => {
  const repo = repoWithProject();
  git(repo, "checkout", "-q", "-b", "feature-b");
  const agent: HostContext = { principalId: "agent:b", permissions: ["model:propose"] };
  assert.equal(engineFor(repo).propose(rename("ch-x", "rev-1", "Waiting (B, pending)"), agent).status, "pending");
  commitAll(repo, "pending proposal ch-x on B");
  git(repo, "checkout", "-q", "main");

  const racing = racingAfter(repo, "getChange", "feature-b");
  // An invalid change with the colliding ID, validated on main, would be saved as "rejected".
  const r = new ModelEngine(racing).propose(
    {
      changeId: "ch-x",
      projectId: "prj-lms",
      expectedRevision: "rev-1",
      operations: [{ type: "removeObject", objectId: "st-rejected" }],
    },
    owner,
  );
  assert.equal(r.status, "rejected");
  assert.equal(r.diagnostics[0]!.code, "STORE_CHANGED");
  assert.equal(git(repo, "status", "--porcelain"), "", "B's HEAD and its pending ch-x record are byte-identical");
});

test("an auto-applied proposal never overwrites another branch's same-ID pending record (PR #8 review, round 7)", () => {
  const repo = repoWithProject();
  git(repo, "checkout", "-q", "-b", "feature-b");
  const agent: HostContext = { principalId: "agent:b", permissions: ["model:propose"] };
  assert.equal(engineFor(repo).propose(rename("ch-x", "rev-1", "Waiting (B, pending)"), agent).status, "pending");
  commitAll(repo, "pending proposal ch-x on B");
  git(repo, "checkout", "-q", "main"); // main: no ch-x

  const r = new ModelEngine(racingAfter(repo, "getChange", "feature-b")).propose(
    rename("ch-x", "rev-1", "Waiting (main)"),
    owner,
  );
  assert.equal(r.status, "rejected");
  assert.equal(r.diagnostics[0]!.code, "STORE_CHANGED");
  assert.equal(git(repo, "status", "--porcelain"), "", "B's HEAD, revisions and pending ch-x are byte-identical");
  assert.equal(new FileStore(join(repo, VCV_DIR)).getChange("ch-x")!.status, "pending");
});

test("approving a pending record that is gone after a checkout writes nothing (PR #8 review, round 7)", () => {
  const repo = repoWithProject();
  git(repo, "branch", "feature-b"); // B: no ch-y
  const agent: HostContext = { principalId: "agent:a", permissions: ["model:propose"] };
  assert.equal(engineFor(repo).propose(rename("ch-y", "rev-1", "Waiting (A, pending)"), agent).status, "pending");
  commitAll(repo, "pending proposal ch-y on main");

  const reviewer: HostContext = { principalId: "user:reviewer", permissions: ["model:approve", "model:apply"] };
  const r = new ModelEngine(racingAfter(repo, "getChange", "feature-b")).approve("ch-y", reviewer);
  assert.equal(r.status, "rejected");
  assert.equal(r.diagnostics[0]!.code, "STORE_CHANGED");
  assert.equal(git(repo, "status", "--porcelain"), "", "no phantom ch-y record and no new revision on B");
});

test("model history survives restart and an ordinary checkout round trip", () => {
  const repo = repoWithProject();
  const e = engineFor(repo);
  const r2 = e.propose(timeoutChange(), owner).record!.resultingRevision!;
  commitAll(repo, "model: timeout");
  const first = git(repo, "rev-parse", "HEAD");
  const r3 = e.propose(rename("ch-r3", r2, "Waiting"), owner).record!.resultingRevision!;
  commitAll(repo, "model: rename");

  git(repo, "checkout", "-q", first);
  const s = projectStatus(repo);
  assert.equal(s.model!.revision, r2);
  assert.equal(s.git!.detached, true);
  git(repo, "checkout", "-q", "main");
  const reopened = RepositoryProject.open(repo);
  assert.deepEqual(reopened.status().model!.history, ["rev-1", r2, r3]);
});

test("a plain directory (no Git) still loads, with a warning that commit context is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "vcv-plain-"));
  initProject(dir, baseModel());
  const s = projectStatus(dir);
  assert.equal(s.state, "ready");
  assert.equal(s.git, null);
  assert.ok(s.diagnostics.some((d) => d.code === "NOT_A_GIT_REPOSITORY"));
  assert.throws(
    () => initProject(dir, baseModel()),
    (e: unknown) => e instanceof StoreError && e.code === "ALREADY_INITIALIZED",
  );
});

test("compareLines classifies history movement", () => {
  assert.equal(compareLines(["a"], ["a"]), "unchanged");
  assert.equal(compareLines(["a"], ["a", "b"]), "advanced");
  assert.equal(compareLines(["a", "b"], ["a"]), "rewound");
  assert.equal(compareLines(["a", "b"], ["a", "c"]), "switched");
  assert.equal(compareLines(null, ["a"]), "appeared");
  assert.equal(compareLines(["a"], null), "disappeared");
});

test("project status reports an unreadable change record like the writer does (PR #8 review, round 8)", () => {
  const repo = repoWithProject();
  const agent: HostContext = { principalId: "agent:a", permissions: ["model:propose"] };
  assert.equal(engineFor(repo).propose(rename("ch-p", "rev-1", "Waiting (pending)"), agent).status, "pending");
  writeFileSync(join(repo, VCV_DIR, "changes", "ch-p.json"), '{"changeId": "ch-p", "status": "pend');
  const s = projectStatus(repo);
  assert.equal(s.state, "invalid");
  assert.equal(s.diagnostics[0]!.code, "INVALID_STORE");
  assert.match(s.diagnostics[0]!.message, /ch-p is unreadable/);
  assert.throws(() => RepositoryProject.open(repo), ProjectError);
  assert.throws(
    () => engineFor(repo),
    (e: unknown) => e instanceof StoreError && e.code === "CORRUPT",
  );
});

test("Git observation keeps both paths of staged and unstaged renames (PR #8 review, round 8)", () => {
  assert.deepEqual(parsePorcelainZ("R  .vcv/b\0.vcv/a\0 M x\0"), [".vcv/b", ".vcv/a", "x"], "staged (X = R)");
  assert.deepEqual(parsePorcelainZ(" R .vcv/b\0.vcv/a\0 M x\0"), [".vcv/b", ".vcv/a", "x"], "unstaged (Y = R)");
  assert.deepEqual(parsePorcelainZ("C  .vcv/c\0.vcv/a\0"), [".vcv/c", ".vcv/a"], "copy");

  // The reviewer's repro: an intent-to-add rename shows up as " R" in the worktree column.
  const repo = repoWithProject();
  git(repo, "mv", `${VCV_DIR}/.gitignore`, `${VCV_DIR}/ignore-renamed`);
  git(repo, "reset", "-q", "HEAD");
  git(repo, "add", "-N", `${VCV_DIR}/ignore-renamed`);
  assert.match(
    git(repo, "status", "--porcelain=v1", "-z"),
    /^R \.vcv\/ignore-renamed\0\.vcv\/\.gitignore\0/,
    'Git 2.18+ reports " R" (the helper trims the leading space)',
  );
  assert.deepEqual(projectStatus(repo).git!.storeChanges, [`${VCV_DIR}/.gitignore`, `${VCV_DIR}/ignore-renamed`]);
});
