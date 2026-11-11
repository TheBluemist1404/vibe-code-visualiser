// Repository-native VCV projects (ADR 0007, Issue #6 M2.1).
//
// A VCV project lives in `.vcv/` at the root of the developer's own checkout and travels with
// the code through ordinary Git commits, branches and PRs. This module finds that directory,
// reports whether its model can be served, and records the checkout's Git state as
// *observation context* next to it. It never creates a model unless asked (initProject),
// never runs store recovery, and never fetches, pulls, checks out or merges.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Model } from "@vcv/ir";
import { FileStore, FileStoreReader, StoreError, inspectStore, readHeadRevision, revisionFileDigest } from "@vcv/core";
import type { StoreInspection } from "@vcv/core";
import { findWorkTreeRoot, observeGit } from "./git.ts";
import type { GitObservation } from "./git.ts";

/** The store directory, relative to the repository root. Fixed so every clone agrees. */
export const VCV_DIR = ".vcv";

/** Written by initProject. Everything listed is local to one checkout (ADR 0007). */
export const VCV_GITIGNORE = `# Local, per-checkout VCV state (docs/adr/0007-repository-projects.md). Not shared via Git.
cache/
orphaned/
audit.jsonl
*.tmp-*
`;

export type ProjectState =
  /** The model can be served. */
  | "ready"
  /** No .vcv/ directory. Nothing is created automatically. */
  | "absent"
  /** .vcv/ exists but holds no initialized store (no HEAD). */
  | "uninitialized"
  /** Store files contain Git conflict markers. */
  | "conflicted"
  /** Revisions from another line of history are present. */
  | "diverged"
  /** HEAD or a committed revision is unreadable or inconsistent. */
  | "invalid";

export type ProjectDiagnostic = { code: string; severity: "error" | "warning" | "info"; message: string };

export type ProjectStatus = {
  state: ProjectState;
  /** Absolute; local to this machine. */
  root: string;
  storeDir: string;
  /** Git state of the checkout, or null when the directory is not a Git working tree. */
  git: GitObservation | null;
  /** Current model revision and its history, when HEAD could be read. */
  model: {
    projectId: string;
    revision: string;
    status: string;
    history: string[];
    /** SHA-256 of the current revision file. Tells apart same-ID revisions on different branches (initial and legacy IDs are not content-addressed). */
    fileDigest: string | null;
  } | null;
  inspection: StoreInspection;
  diagnostics: ProjectDiagnostic[];
};

/** How the served model line moved between two observations of the same checkout. */
export type ModelLineChange =
  | "unchanged"
  /** New revisions on top of the previous one (a commit, a pull, a fast-forward checkout). */
  | "advanced"
  /** The previous revision is a descendant of the current one (an older commit was checked out). */
  | "rewound"
  /** Neither history contains the other's head: a different branch's model. */
  | "switched"
  /** A model is available now that was not before, or the reverse. */
  | "appeared"
  | "disappeared";

export type ProjectRefresh = { status: ProjectStatus; previous: ProjectStatus; modelLine: ModelLineChange; gitCommitChanged: boolean; branchChanged: boolean };

/** Resolve the repository root for `path`: the Git working tree root, or the directory itself. */
export function resolveProjectRoot(path: string): { root: string; isGit: boolean } {
  const abs = resolve(path);
  const root = findWorkTreeRoot(abs);
  return root ? { root, isGit: true } : { root: abs, isGit: false };
}

/** Describe the project in a checkout. Read-only. */
export function projectStatus(path: string): ProjectStatus {
  const { root, isGit } = resolveProjectRoot(path);
  const storeDir = join(root, VCV_DIR);
  const git = isGit ? observeGit(root, VCV_DIR) : null;
  const inspection = inspectStore(storeDir);
  const diagnostics: ProjectDiagnostic[] = [];
  let model: ProjectStatus["model"] = null;
  let state: ProjectState;

  switch (inspection.state) {
    case "absent":
      state = "absent";
      diagnostics.push({ code: "NO_PROJECT", severity: "error", message: `no ${VCV_DIR}/ directory in ${root}; create one explicitly with \`vcv project init\`` });
      break;
    case "uninitialized":
      state = "uninitialized";
      diagnostics.push({ code: "NOT_INITIALIZED", severity: "error", message: `${VCV_DIR}/ exists but holds no model store (no ${VCV_DIR}/HEAD)` });
      break;
    case "conflicted":
      state = "conflicted";
      diagnostics.push({
        code: "CONFLICTED",
        severity: "error",
        message: `unresolved Git conflict in ${inspection.files.map((f) => `${VCV_DIR}/${f}`).join(", ")}; VCV does not merge model histories. Resolve the merge or check out one side.`,
      });
      break;
    case "invalid":
      state = "invalid";
      diagnostics.push({ code: "INVALID_STORE", severity: "error", message: inspection.message });
      break;
    case "diverged":
    case "ok": {
      state = inspection.state === "ok" ? "ready" : "diverged";
      const m = readHeadRevision(storeDir); // the reader would (rightly) refuse a diverged store
      model = {
        projectId: m.project.id,
        revision: inspection.revision,
        status: m.project.status,
        history: inspection.history,
        fileDigest: revisionFileDigest(storeDir, inspection.revision),
      };
      if (inspection.state === "diverged") {
        diagnostics.push({
          code: "DIVERGED",
          severity: "error",
          message:
            `revisions ${inspection.foreign.map((f) => f.id).join(", ")} are not in ${VCV_DIR}/HEAD's history; they probably come from another branch. ` +
            "VCV will not drop or merge them: keep one line of history (remove the other revision files) or restore the matching HEAD.",
        });
      }
      for (const l of inspection.leftovers) {
        diagnostics.push({ code: "UNCOMMITTED_REVISION", severity: "info", message: `${l.id} is left over from an interrupted commit; the next write will move it to ${VCV_DIR}/orphaned/` });
      }
      break;
    }
  }

  if (!git) diagnostics.push({ code: "NOT_A_GIT_REPOSITORY", severity: "warning", message: `${root} is not a Git working tree; commit and branch context is unavailable` });
  else {
    if (git.operation) diagnostics.push({ code: "GIT_OPERATION_IN_PROGRESS", severity: "warning", message: `a Git ${git.operation} is in progress; ${VCV_DIR}/ may be half-merged` });
    if (git.storeChanges.length) {
      diagnostics.push({ code: "UNCOMMITTED_MODEL_CHANGES", severity: "info", message: `${git.storeChanges.length} ${VCV_DIR}/ path(s) differ from Git HEAD ${git.commit ?? "(no commits)"}` });
    }
  }
  return { state, root, storeDir, git, model, inspection, diagnostics };
}

export class ProjectError extends Error {
  readonly status: ProjectStatus;
  constructor(status: ProjectStatus) {
    super(status.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ") || `project is ${status.state}`);
    this.name = "ProjectError";
    this.status = status;
  }
}

/**
 * An opened project: a read-only model reader plus the observation it was opened with.
 * Queries go through `reader`; `refresh()` re-observes the checkout and reports how the model
 * line moved (for example after `git checkout other-branch`), without writing anything.
 */
export class RepositoryProject {
  readonly root: string;
  readonly storeDir: string;
  readonly reader: FileStoreReader;
  private last: ProjectStatus;

  private constructor(status: ProjectStatus) {
    this.root = status.root;
    this.storeDir = status.storeDir;
    this.reader = new FileStoreReader(status.storeDir);
    this.last = status;
  }

  /** Open the project in the checkout containing `path`. Throws ProjectError unless it is ready. */
  static open(path: string): RepositoryProject {
    const status = projectStatus(path);
    if (status.state !== "ready") throw new ProjectError(status);
    return new RepositoryProject(status);
  }

  status(): ProjectStatus {
    return this.last;
  }

  refresh(): ProjectRefresh {
    const previous = this.last;
    const status = projectStatus(this.root);
    this.last = status;
    return {
      status,
      previous,
      modelLine: lineChange(previous, status),
      gitCommitChanged: (previous.git?.commit ?? null) !== (status.git?.commit ?? null),
      branchChanged: (previous.git?.branch ?? null) !== (status.git?.branch ?? null),
    };
  }
}

function lineChange(previous: ProjectStatus, now: ProjectStatus): ModelLineChange {
  const change = compareLines(previous.model?.history ?? null, now.model?.history ?? null);
  // Same IDs, different bytes: e.g. two branches that each initialized their own rev-1.
  if (change === "unchanged" && previous.model && now.model && previous.model.fileDigest !== now.model.fileDigest) return "switched";
  return change;
}

export function compareLines(before: readonly string[] | null, after: readonly string[] | null): ModelLineChange {
  if (!before && !after) return "unchanged";
  if (!before) return "appeared";
  if (!after) return "disappeared";
  const prefix = (a: readonly string[], b: readonly string[]) => a.length <= b.length && a.every((r, i) => b[i] === r);
  if (before.length === after.length && prefix(before, after)) return "unchanged";
  if (prefix(before, after)) return "advanced";
  if (prefix(after, before)) return "rewound";
  return "switched";
}

/**
 * Create `.vcv/` in the checkout containing `path`, from an explicit, valid initial model.
 * This is the only way a project is created; opening or refreshing never does it.
 */
export function initProject(path: string, initial: Model): ProjectStatus {
  const { root } = resolveProjectRoot(path);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new StoreError("NOT_INITIALIZED", `${root} is not a directory`);
  const storeDir = join(root, VCV_DIR);
  if (existsSync(join(storeDir, "HEAD"))) throw new StoreError("ALREADY_INITIALIZED", `${storeDir} already holds a model store`);
  mkdirSync(storeDir, { recursive: true });
  FileStore.init(storeDir, initial);
  writeFileSync(join(storeDir, ".gitignore"), VCV_GITIGNORE);
  return projectStatus(root);
}
