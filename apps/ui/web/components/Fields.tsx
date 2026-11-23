// The inspector's edit section: each field the host offers, with the typed operation it
// becomes, and every read-only field with the reason. Editing here only stages a change; the
// model changes when a reviewer approves the proposal outside the browser.
import { useEffect, useRef, useState } from "react";
import type { FieldAccess, GraphView } from "../../src/types.ts";
import { useDraft } from "../draft.tsx";
import { Icon } from "../icons.tsx";

type Editable = FieldAccess["editable"][number];

type Props = {
  access: FieldAccess;
  objectId: string;
  objectName: string;
  objectKind: string;
  graph: GraphView;
};

export function Fields({ access, objectId, objectName, objectKind, graph }: Props) {
  return (
    <section className="sec" data-testid="fields">
      <h2 className="sec-head">
        <Icon name="pencil" /> Propose a change
      </h2>
      <p className="small muted" style={{ margin: "0 0 var(--space-2)" }}>
        Edits are staged, then submitted as a pending proposal. The model changes only when a reviewer approves it.
      </p>
      {access.editable.length > 0 && (
        <ul className="fields">
          {access.editable.map((f) => (
            <Field
              key={f.field}
              f={f}
              objectId={objectId}
              objectName={objectName}
              objectKind={objectKind}
              graph={graph}
            />
          ))}
        </ul>
      )}
      <ul className="fields fields-ro" aria-label="Read-only fields">
        {access.readOnly.map((f) => (
          <li key={f.field} className="field is-ro" data-testid={`readonly-${f.field}`}>
            <Icon name="lock" small />
            <span className="field-main">
              <span className="field-label">{f.label}</span>
              <span className="small muted">{f.reason}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const show = (v: string | string[] | null, names: Map<string, string>) =>
  v === null || v === ""
    ? "none"
    : Array.isArray(v)
      ? v.length
        ? v.map((id) => names.get(id) ?? id).join(", ")
        : "none"
      : v;

function Field({ f, objectId, objectName, objectKind, graph }: { f: Editable } & Omit<Props, "access">) {
  const draft = useDraft();
  const staged = draft.staged(objectId, f.field);
  const [editing, setEditing] = useState(false);
  const names = new Map(graph.modules.map((m) => [m.id, m.name]));
  const value = staged ? staged.value : f.value;
  return (
    <li className={`field${staged ? " is-staged" : ""}`} data-testid={`field-${f.field}`}>
      <span className="field-main">
        <span className="field-label">
          {f.label}
          <span className="op mono" title="The typed operation this edit becomes">
            {f.operation}
          </span>
          {staged && <span className="chip chip-staged">Staged</span>}
        </span>
        {editing ? (
          <Editor
            f={f}
            value={value}
            self={objectId}
            graph={graph}
            onCancel={() => setEditing(false)}
            onStage={(v) => {
              draft.stage({
                objectId,
                field: f.field,
                value: v,
                label: f.label,
                objectName,
                objectKind,
                before: f.value,
              });
              setEditing(false);
            }}
          />
        ) : (
          <span className={`field-value${value === null || value === "" ? " muted" : ""}`}>
            {staged && <s className="muted">{show(f.value, names)}</s>}
            <span>{show(value, names)}</span>
          </span>
        )}
      </span>
      {!editing && (
        <span className="field-actions">
          {staged && (
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              title="Unstage"
              aria-label={`Unstage ${f.label}`}
              onClick={() => draft.unstage(objectId, f.field)}
            >
              <Icon name="x" small />
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            title={`Edit ${f.label}`}
            aria-label={`Edit ${f.label}`}
            onClick={() => setEditing(true)}
          >
            <Icon name="pencil" small />
          </button>
        </span>
      )}
    </li>
  );
}

function Editor({
  f,
  value,
  self,
  graph,
  onStage,
  onCancel,
}: {
  f: Editable;
  value: string | string[] | null;
  self: string;
  graph: GraphView;
  onStage(v: string | string[]): void;
  onCancel(): void;
}) {
  const [text, setText] = useState(typeof value === "string" ? value : "");
  const [deps, setDeps] = useState<string[]>(Array.isArray(value) ? value : []);
  // The person just asked to edit this field, so the field takes focus.
  const first = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus(), []);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onStage(f.input === "modules" ? deps : text);
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  };
  return (
    <form className="editor" onSubmit={submit} onKeyDown={keys}>
      {f.input === "line" && (
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={f.label}
          ref={first as React.RefObject<HTMLInputElement>}
        />
      )}
      {f.input === "text" && (
        <textarea
          className="input"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={f.label}
          ref={first as React.RefObject<HTMLTextAreaElement>}
        />
      )}
      {f.input === "modules" && (
        <fieldset className="checks">
          <legend className="sr-only">{f.label}</legend>
          {graph.modules
            .filter((m) => m.id !== self)
            .map((m) => (
              <label key={m.id} className="check">
                <input
                  type="checkbox"
                  checked={deps.includes(m.id)}
                  onChange={(e) => setDeps((d) => (e.target.checked ? [...d, m.id] : d.filter((x) => x !== m.id)))}
                />
                <span>{m.name}</span>
                <span className="mono muted">{m.id}</span>
              </label>
            ))}
        </fieldset>
      )}
      <div className="row">
        <button type="submit" className="btn btn-primary">
          Stage
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
