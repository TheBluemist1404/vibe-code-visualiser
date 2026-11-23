// Persistent canvas positions, one file per checkout and model project, kept on this machine
// outside the checkout. Never written under .vcv/ and never part of a model revision.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Position } from "./types.ts";

const FORMAT = "vcv-ui-layout-1";

type LayoutFile = { format: typeof FORMAT; root: string; projectId: string; modules: Record<string, Position> };

/** VCV_UI_STATE_DIR, else $XDG_STATE_HOME/vcv/ui, else ~/.local/state/vcv/ui. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VCV_UI_STATE_DIR) return env.VCV_UI_STATE_DIR;
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "vcv", "ui");
}

export class LayoutFileStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  /** The file holding positions for `projectId` in the checkout at `root`. */
  pathFor(root: string, projectId: string): string {
    const key = createHash("sha256").update(`${root}\0${projectId}`).digest("hex").slice(0, 24);
    return join(this.dir, `layout-${key}.json`);
  }

  /** Stored positions, or none. A missing, unreadable or foreign file reads as empty. */
  load(root: string, projectId: string): Record<string, Position> {
    try {
      const data = JSON.parse(readFileSync(this.pathFor(root, projectId), "utf8")) as Partial<LayoutFile>;
      if (data.format !== FORMAT || data.root !== root || data.projectId !== projectId) return {};
      const out: Record<string, Position> = {};
      for (const [id, p] of Object.entries(data.modules ?? {})) {
        if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) out[id] = { x: p.x, y: p.y, pinned: p.pinned === true };
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Replace the stored positions (write to a temporary file, then rename). */
  save(root: string, projectId: string, modules: Record<string, Position>): void {
    mkdirSync(this.dir, { recursive: true });
    const path = this.pathFor(root, projectId);
    const file: LayoutFile = { format: FORMAT, root, projectId, modules };
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(tmp, path);
  }
}
