// The module list beside the canvas: the keyboard and screen-reader path to every module.
import { useEffect, useRef, useState } from "react";
import type { GraphView } from "../../src/types.ts";
import { Icon } from "../icons.tsx";

export function ModuleList({
  graph,
  selected,
  fresh,
  onSelect,
}: {
  graph: GraphView;
  selected: string | null;
  fresh: ReadonlySet<string>;
  onSelect(id: string): void;
}) {
  const [filter, setFilter] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const q = filter.trim().toLowerCase();
  const shown = [...graph.modules]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.includes(q));
  return (
    <nav className="side" aria-label="Modules">
      <div className="side-head">
        Modules<span className="count">{graph.modules.length}</span>
      </div>
      <label className="search">
        <Icon name="search" />
        <input
          ref={input}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter modules"
          aria-label="Filter modules"
        />
        <kbd>/</kbd>
      </label>
      <ul className="mods">
        {shown.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              className="mod"
              aria-current={m.id === selected}
              onClick={() => onSelect(m.id)}
              data-testid={`list-${m.id}`}
            >
              {m.name}
              <span className="mono">
                {m.id}
                {fresh.has(m.id) && <span>· new</span>}
                {graph.positions[m.id]?.pinned && <span>· pinned</span>}
              </span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="small muted">No module matches “{filter}”.</li>}
      </ul>
      {graph.truncated && (
        <p className="small muted">
          Showing {graph.truncated.shown} of {graph.truncated.total} modules.
        </p>
      )}
      <div className="side-foot">
        Positions are saved on this computer for this checkout. They are never written to .vcv/ and never create a
        revision.
      </div>
    </nav>
  );
}
