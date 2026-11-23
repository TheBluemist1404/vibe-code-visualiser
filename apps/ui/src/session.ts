// One opened checkout. Every read observes the checkout again (project status, Git, HEAD) and
// serves the model only when the project is ready. Nothing here creates, repairs or writes
// anything under the checkout; the only write is canvas positions, to the layout store.
import { FileStoreReader } from "@vcv/core";
import type { Model } from "@vcv/ir";
import { compareLines, projectStatus } from "@vcv/repo";
import type { ProjectStatus } from "@vcv/repo";
import { createQueryApi } from "@vcv/query";
import type { QueryApi } from "@vcv/query";
import { moduleGraph } from "./graph.ts";
import { moduleView, NotFoundError, objectView } from "./inspector.ts";
import { reconcile, tidy } from "./layout.ts";
import type { LayoutFileStore } from "./layout-store.ts";
import type { GraphView, ModelChange, ModuleView, ObjectView, Observation, Position, ProjectView } from "./types.ts";

const MAX_MODULES = 1000;

type Served = { status: ProjectStatus; modules: string[] };

/** A model snapshot that matches the project status it is served with. */
type Snapshot =
  | { status: ProjectStatus; model: Model; query: QueryApi; key: string }
  | { status: ProjectStatus; model: null };

/** Test seam: runs after the model is read and before the checkout is observed again. */
export type SessionHooks = { afterModelRead?: () => void };

/** How often a read is retried when the checkout moves under it. */
const READ_ATTEMPTS = 3;

export class StateChangedError extends Error {
  readonly code = "STATE_CHANGED";
}

/** Identity of the served model: revision ID plus revision file digest. */
export function modelKey(status: ProjectStatus): string | null {
  return status.model ? `${status.model.revision}@${status.model.fileDigest ?? "unknown"}` : null;
}

/** True when two observations show the same checkout state: model, commit and branch. */
function sameState(a: ProjectStatus, b: ProjectStatus): boolean {
  return (
    a.state === b.state &&
    modelKey(a) === modelKey(b) &&
    (a.git?.commit ?? null) === (b.git?.commit ?? null) &&
    (a.git?.branch ?? null) === (b.git?.branch ?? null)
  );
}

export class ProjectSession {
  readonly path: string;
  private readonly layouts: LayoutFileStore;
  private reader: { storeDir: string; reader: FileStoreReader } | null = null;
  private last: Served | null = null;
  private change: ModelChange | null = null;
  private seq = 0;
  private readonly hooks: SessionHooks;

  constructor(path: string, layouts: LayoutFileStore, hooks: SessionHooks = {}) {
    this.path = path;
    this.layouts = layouts;
    this.hooks = hooks;
  }

  /** Observe the checkout and build the canvas view. */
  view(): ProjectView {
    const snap = this.read();
    const graph = snap.model ? this.graph(snap.status, snap.model, snap.query, snap.key) : null;
    this.track(snap.status, graph);
    return { observation: observation(snap.status), graph, lastChange: this.change };
  }

  module(id: string): ModuleView {
    const s = this.requireReady();
    return moduleView(s.model, s.query, id, s.key);
  }

  object(id: string): ObjectView {
    const s = this.requireReady();
    return objectView(s.model, s.query, id, s.key);
  }

  /** Pin a module where the user dropped it. Presentation state only. */
  pin(id: string, x: number, y: number): Record<string, Position> {
    return this.updateLayout((ids, stored) => {
      if (!ids.includes(id)) throw new NotFoundError("UNKNOWN_ID", `no module ${id} in the current model`);
      return { ...stored, [id]: { x: Math.round(x), y: Math.round(y), pinned: true } };
    });
  }

  /** Unpin a module; it keeps its place until the next tidy. */
  unpin(id: string): Record<string, Position> {
    return this.updateLayout((_ids, stored) => {
      const p = stored[id];
      return p ? { ...stored, [id]: { ...p, pinned: false } } : stored;
    });
  }

  /** Re-place every unpinned module automatically. */
  tidy(): Record<string, Position> {
    return this.updateLayout((ids, stored, edges) => tidy({ ids, edges }, stored));
  }

  private updateLayout(
    fn: (
      ids: string[],
      stored: Record<string, Position>,
      edges: { from: string; to: string }[],
    ) => Record<string, Position>,
  ): Record<string, Position> {
    const s = this.requireReady();
    const view = this.graph(s.status, s.model, s.query, s.key);
    const ids = view.modules.map((m) => m.id);
    const next = fn(ids, view.positions, view.edges);
    this.layouts.save(s.status.root, s.model.project.id, next);
    return next;
  }

  private requireReady() {
    const snap = this.read();
    if (!snap.model)
      throw new NotFoundError("NOT_READY", `the project is ${snap.status.state}; nothing can be read from it`);
    return snap;
  }

  /**
   * Observe the checkout, read the model, and observe again. The model is served only when both
   * observations agree (same model identity, commit and branch) and the model read is the one
   * they name; otherwise the checkout moved mid-read (a branch switch, a commit) and the read is
   * retried, so status, model and Git metadata in one answer always belong together.
   */
  private read(): Snapshot {
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const status = projectStatus(this.path);
      if (status.state !== "ready" || !status.model) {
        this.reader = null;
        return { status, model: null };
      }
      if (this.reader?.storeDir !== status.storeDir)
        this.reader = { storeDir: status.storeDir, reader: new FileStoreReader(status.storeDir) };
      let model: Model;
      try {
        model = this.reader.reader.current();
      } catch {
        continue; // the store moved under the reader; observe again
      }
      this.hooks.afterModelRead?.();
      const again = projectStatus(this.path);
      if (sameState(status, again) && model.project.modelRevision === status.model.revision) {
        return { status, model, query: createQueryApi({ current: () => model }), key: modelKey(status) as string };
      }
    }
    throw new StateChangedError("the checkout kept changing while it was read; try again");
  }

  private graph(status: ProjectStatus, model: Model, query: QueryApi, key: string): GraphView {
    const modules = [];
    let cursor: string | undefined;
    let validation = { errors: 0, warnings: 0 };
    let total = 0;
    do {
      const page = query.getProjectOverview({ moduleLimit: 200, ...(cursor ? { cursor } : {}) });
      if (!page.ok) throw new Error(`${page.error.code}: ${page.error.message}`);
      modules.push(...page.data.modules);
      validation = page.data.validation;
      total = page.data.modulesTotal;
      cursor = page.data.nextCursor;
    } while (cursor && modules.length < MAX_MODULES);
    const g = moduleGraph(model, { modules });
    const stored = this.layouts.load(status.root, model.project.id);
    const { positions, placed } = reconcile({ ids: g.modules.map((m) => m.id), edges: g.edges }, stored);
    if (placed.length || Object.keys(stored).length !== Object.keys(positions).length)
      this.layouts.save(status.root, model.project.id, positions);
    // A first open places everything; only modules that appear later are "new".
    const first = Object.keys(stored).length === 0;
    return {
      project: {
        id: model.project.id,
        name: model.project.name,
        ...(model.project.description ? { description: model.project.description } : {}),
      },
      revision: model.project.modelRevision,
      modelKey: key,
      modules: g.modules,
      edges: g.edges,
      unresolved: g.unresolved,
      positions,
      placed: first ? [] : placed,
      validation,
      ...(total > modules.length ? { truncated: { shown: modules.length, total } } : {}),
    };
  }

  /** Remember what was served, and record how the model moved since the previous read. */
  private track(status: ProjectStatus, graph: GraphView | null): void {
    const modules = graph ? graph.modules.map((m) => m.id) : [];
    const prev = this.last;
    this.last = { status, modules };
    if (!prev) return;
    let line = compareLines(prev.status.model?.history ?? null, status.model?.history ?? null);
    if (line === "unchanged" && prev.status.model?.fileDigest !== status.model?.fileDigest) line = "switched";
    if (line === "unchanged") return;
    const before = new Set(prev.modules);
    const after = new Set(modules);
    this.change = {
      seq: ++this.seq,
      modelLine: line,
      before: { revision: prev.status.model?.revision ?? null, branch: prev.status.git?.branch ?? null },
      after: { revision: status.model?.revision ?? null, branch: status.git?.branch ?? null },
      added: modules.filter((m) => !before.has(m)),
      removed: prev.modules.filter((m) => !after.has(m)),
      at: new Date().toISOString(),
    };
  }
}

function observation(s: ProjectStatus): Observation {
  return {
    state: s.state,
    root: s.root,
    git: s.git
      ? {
          commit: s.git.commit,
          branch: s.git.branch,
          detached: s.git.detached,
          dirty: s.git.dirty,
          storeChanges: s.git.storeChanges,
          operation: s.git.operation,
        }
      : null,
    model: s.model
      ? {
          projectId: s.model.projectId,
          revision: s.model.revision,
          status: s.model.status,
          history: s.model.history,
          key: modelKey(s) as string,
        }
      : null,
    diagnostics: s.diagnostics,
    observedAt: new Date().toISOString(),
  };
}
