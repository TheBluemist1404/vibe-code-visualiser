// Presentation state (positions, collapse) for canvases. Separate from the model engine:
// layout edits never create a model revision.
import type { Id } from "@vcv/ir";

export type NodeLayout = { x: number; y: number; collapsed?: boolean };

export class LayoutStore {
  private readonly nodes = new Map<string, NodeLayout>();
  set(view: string, id: Id, layout: NodeLayout): void {
    this.nodes.set(`${view}:${id}`, layout);
  }
  get(view: string, id: Id): NodeLayout | undefined {
    return this.nodes.get(`${view}:${id}`);
  }
}
