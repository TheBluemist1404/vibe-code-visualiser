// Real checkouts for the UI tests: Git repositories with a .vcv/ store made by the same code
// the CLI uses (initProject, ModelEngine). Test-only.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FileStore, ModelEngine } from "@vcv/core";
import { loadModel } from "@vcv/ir";
import { initProject, projectStatus } from "@vcv/repo";
import { git, tempDir } from "@vcv/testkit";

export { git, tempDir };

const ROOT = join(import.meta.dirname, "../../..");
/** The Course Desk model an agent drafted in M2.3: Web → Enrollment → Notifications, Web → Notifications. */
export const DRAFT = join(ROOT, "docs/samples/m2.3-bootstrap/agent-output/model.yaml");

const owner = { principalId: "user:dev", permissions: ["model:propose", "model:apply"] as const };

/** A Git repository with one commit containing README.md. */
export function emptyRepo(name = "checkout"): string {
  const repo = join(realpathSync(tempDir("vcv-ui-")), name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  return repo;
}

/** Course Desk's drafted model, initialized and committed on main. */
export function courseDesk(): string {
  const repo = emptyRepo("course-desk");
  const parsed = loadModel(readFileSync(DRAFT, "utf8"));
  if (!parsed.model) throw new Error("the draft model does not load");
  initProject(repo, parsed.model);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "vcv: draft model");
  return repo;
}

function propose(repo: string, changeId: string, operations: unknown[]): string {
  const out = new ModelEngine(new FileStore(join(repo, ".vcv"))).propose(
    { changeId, projectId: "prj-course-desk", expectedRevision: projectStatus(repo).model?.revision, operations },
    owner,
  );
  if (out.status !== "applied" || !out.record?.resultingRevision) throw new Error(JSON.stringify(out));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `vcv: ${changeId}`);
  return out.record.resultingRevision;
}

/** Add an Audit log module that depends on Enrollment, through the typed createModule operation. */
export function addAuditModule(repo: string): string {
  return propose(repo, "chg-audit", [
    {
      type: "createModule",
      module: {
        id: "mod-audit",
        kind: "module",
        owner: "prj-course-desk",
        name: "Audit log",
        purpose: "Append-only record of enrollment decisions for staff review.",
        dependsOn: ["mod-enrollment"],
      },
    },
  ]);
}

/** A criterion owned by Web that verifies Enrollment's capability: a cross-module reference. */
export function addWebCriterion(repo: string): string {
  return propose(repo, "chg-web-criterion", [
    {
      type: "createCriterion",
      criterion: {
        id: "crt-page-enrolls",
        kind: "criterion",
        owner: "mod-web",
        name: "The page enrolls through the API",
        statement: "Submitting the form sends one enrollment request and shows the recorded decision.",
        verifies: ["cap-enroll"],
        verification: "optional",
      },
    },
  ]);
}

/** A branch whose own .vcv/ was initialized separately: the same revision ID (rev-1), a different model. */
export function orphanBranchWithOtherModel(repo: string, branch: string, rename: string): void {
  git(repo, "checkout", "-q", "--orphan", branch);
  git(repo, "rm", "-rfq", ".");
  const parsed = loadModel(readFileSync(DRAFT, "utf8"));
  if (!parsed.model) throw new Error("the draft model does not load");
  const web = parsed.model.modules.find((m) => m.id === "mod-web");
  if (web) web.name = rename;
  initProject(repo, parsed.model);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "vcv: another rev-1");
}

export function renameModule(repo: string, changeId: string, id: string, name: string): string {
  return propose(repo, changeId, [{ type: "renameObject", objectId: id, name }]);
}

/** Two branches renamed the same module differently and were merged: .vcv/HEAD conflicts. */
export function conflictedRepo(): string {
  const repo = courseDesk();
  git(repo, "checkout", "-q", "-b", "feature-a");
  renameModule(repo, "chg-a", "mod-web", "Web (A)");
  git(repo, "checkout", "-q", "main");
  git(repo, "checkout", "-q", "-b", "feature-b");
  renameModule(repo, "chg-b", "mod-web", "Web (B)");
  try {
    git(repo, "merge", "-q", "feature-a");
  } catch {
    // expected: the merge stops on .vcv/HEAD
  }
  return repo;
}

/** The committed revision file was overwritten with something that is not a model. */
export function invalidRepo(): string {
  const repo = courseDesk();
  const dir = join(repo, ".vcv", "revisions");
  for (const f of readdirSync(dir)) writeFileSync(join(dir, f), "not: [a model\n");
  return repo;
}

/** .vcv/ exists but has no HEAD. */
export function uninitializedRepo(): string {
  const repo = emptyRepo();
  mkdirSync(join(repo, ".vcv"));
  writeFileSync(join(repo, ".vcv", ".keep"), "");
  return repo;
}

/** Every file under `dir` (except .git/) with a hash of its bytes: to show nothing was written. */
export function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (relative(dir, p) === ".git") continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}
