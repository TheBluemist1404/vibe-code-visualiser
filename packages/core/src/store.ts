// Persistence for approved model revisions and change records. Git-friendly files:
//   <dir>/revisions/<rev>.yaml   one file per model revision (never rewritten)
//   <dir>/changes/<changeId>.json one external ChangeRecord per proposal
//   <dir>/HEAD                    current revision id
// A model revision is not a Git commit; committing this folder to Git is a separate step.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpModel, loadModel } from "@vcv/ir";
import type { Model } from "@vcv/ir";
import type { ChangeRecord } from "./engine.ts";

export interface ModelStore {
  current(): Model;
  revision(rev: string): Model | undefined;
  revisions(): string[];
  /** Persist a new revision together with the change record that produced it. */
  commit(model: Model, record: ChangeRecord): void;
  getChange(changeId: string): ChangeRecord | undefined;
  putChange(record: ChangeRecord): void;
}

export class MemoryStore implements ModelStore {
  private readonly revs = new Map<string, Model>();
  private readonly order: string[] = [];
  private readonly changes = new Map<string, ChangeRecord>();

  constructor(initial: Model) {
    this.add(initial);
  }
  current(): Model {
    return structuredClone(this.revs.get(this.order.at(-1)!)!);
  }
  revision(rev: string): Model | undefined {
    const m = this.revs.get(rev);
    return m && structuredClone(m);
  }
  revisions(): string[] {
    return [...this.order];
  }
  commit(model: Model, record: ChangeRecord): void {
    this.add(model);
    this.putChange(record);
  }
  getChange(id: string): ChangeRecord | undefined {
    const r = this.changes.get(id);
    return r && structuredClone(r);
  }
  putChange(record: ChangeRecord): void {
    this.changes.set(record.changeId, structuredClone(record));
  }
  private add(model: Model) {
    const rev = model.project.modelRevision;
    if (this.revs.has(rev)) throw new Error(`revision ${rev} already exists`);
    this.revs.set(rev, structuredClone(model));
    this.order.push(rev);
  }
}

export class FileStore implements ModelStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(join(dir, "HEAD"))) throw new Error(`${dir} is not an initialized model store (run init first)`);
  }

  static init(dir: string, initial: Model): FileStore {
    if (existsSync(join(dir, "HEAD"))) throw new Error(`${dir} already holds a model store`);
    mkdirSync(join(dir, "revisions"), { recursive: true });
    mkdirSync(join(dir, "changes"), { recursive: true });
    const rev = initial.project.modelRevision;
    atomicWrite(join(dir, "revisions", `${rev}.yaml`), dumpModel(initial));
    atomicWrite(join(dir, "HEAD"), rev + "\n");
    return new FileStore(dir);
  }

  current(): Model {
    return this.revision(readFileSync(join(this.dir, "HEAD"), "utf8").trim())!;
  }
  revision(rev: string): Model | undefined {
    const p = join(this.dir, "revisions", `${rev}.yaml`);
    if (!existsSync(p)) return undefined;
    const r = loadModel(readFileSync(p, "utf8"));
    if (!r.model) throw new Error(`stored revision ${rev} is unreadable: ${r.diagnostics.map((d) => d.message).join("; ")}`);
    return r.model;
  }
  revisions(): string[] {
    return readdirSync(join(this.dir, "revisions")).map((f) => f.replace(/\.yaml$/, ""));
  }
  commit(model: Model, record: ChangeRecord): void {
    const rev = model.project.modelRevision;
    const p = join(this.dir, "revisions", `${rev}.yaml`);
    if (existsSync(p)) throw new Error(`revision ${rev} already exists`);
    atomicWrite(p, dumpModel(model));
    this.putChange(record);
    atomicWrite(join(this.dir, "HEAD"), rev + "\n"); // HEAD moves last
  }
  getChange(id: string): ChangeRecord | undefined {
    const p = join(this.dir, "changes", `${safe(id)}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as ChangeRecord) : undefined;
  }
  putChange(record: ChangeRecord): void {
    atomicWrite(join(this.dir, "changes", `${safe(record.changeId)}.json`), JSON.stringify(record, null, 2) + "\n");
  }
}

function safe(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`change id "${id}" has characters not allowed in a file name`);
  return id;
}

function atomicWrite(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
