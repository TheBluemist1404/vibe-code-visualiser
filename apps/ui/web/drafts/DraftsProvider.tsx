// Client state for local drafts. The drafts themselves live on the host, in files outside the
// checkout; this only remembers which draft this tab is working on and mirrors the host's answers.
// Every change sends the version it was made on, so a second tab gets an explicit conflict.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  DraftList,
  DraftRequest,
  DraftStepView,
  DraftView,
  EditableFieldName,
  StagedEdit,
} from "../../src/types.ts";
import { api, HostError } from "../api.ts";

export type Notice = { tone: "warn" | "danger"; text: string };

export type DraftsApi = {
  list: DraftList | null;
  active: DraftView | null;
  notice: Notice | null;
  dismissNotice(): void;
  select(draftId: string): void;
  newDraft(): Promise<void>;
  /** Stage one edit on the active draft, starting a draft when there is none. */
  stage(edit: StagedEdit): Promise<boolean>;
  unstage(key: string): Promise<void>;
  setRationale(text: string): Promise<void>;
  setRequest(request: DraftRequest): Promise<void>;
  /**
   * Wait for every rationale and request save started so far. Resolves to null when the draft's
   * texts are all stored, or to why one is not, so a handoff never goes out with an older text.
   */
  settled(draftId: string): Promise<string | null>;
  discard(draftId: string, version: number | null): Promise<void>;
  staged(objectId: string, field: EditableFieldName): DraftStepView | undefined;
};

const Ctx = createContext<DraftsApi | null>(null);

export function useDrafts(): DraftsApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useDrafts outside DraftsProvider");
  return api;
}

/** Which draft this tab works on, per project. sessionStorage is per tab; it may be unavailable. */
const remember = {
  key: (projectId: string) => `vcv-ui:draft:${projectId}`,
  get(projectId: string): string | null {
    try {
      return sessionStorage.getItem(this.key(projectId));
    } catch {
      return null;
    }
  },
  set(projectId: string, draftId: string | null) {
    try {
      if (draftId) sessionStorage.setItem(this.key(projectId), draftId);
      else sessionStorage.removeItem(this.key(projectId));
    } catch {
      /* per-tab convenience only */
    }
  },
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function DraftsProvider({
  projectId,
  modelKey,
  children,
}: {
  projectId: string | null;
  modelKey: string | null;
  children: React.ReactNode;
}) {
  const [list, setList] = useState<DraftList | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const seq = useRef(0);
  // Text saves (rationale, request) run one after another on the newest stored version, so a
  // second blur does not race the first. `saves` is the tail of that chain. `unsaved` holds, per
  // field, why its last save was not stored; the field's next stored (or unchanged) save clears it.
  const saves = useRef<Promise<void>>(Promise.resolve());
  const unsaved = useRef(new Map<string, string>());
  const latest = useRef<DraftView | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return setList(null);
    const mine = ++seq.current;
    try {
      const next = await api.drafts.list();
      if (mine !== seq.current) return;
      setList(next);
      setActiveId((id) => {
        const wanted = id ?? remember.get(projectId);
        const found = next.drafts.find((d) => d.draftId === wanted) ?? next.drafts[0] ?? null;
        return found?.draftId ?? null;
      });
    } catch (e) {
      if (mine === seq.current && !(e instanceof HostError && e.status === 409))
        setNotice({ tone: "danger", text: message(e) });
    }
  }, [projectId]);

  // Read again when the project or its model changes, and when the tab regains focus (another
  // tab may have changed a draft).
  // biome-ignore lint/correctness/useExhaustiveDependencies: modelKey is a trigger, not an input
  useEffect(() => {
    refresh();
  }, [refresh, modelKey]);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  // Remember a chosen draft (not the empty start, which would forget the choice before a reload reads it).
  useEffect(() => {
    if (projectId && activeId) remember.set(projectId, activeId);
  }, [projectId, activeId]);

  const active = list?.drafts.find((d) => d.draftId === activeId) ?? null;
  latest.current = active;

  /** Put one draft's new state into the list. */
  const put = useCallback((d: DraftView) => {
    if (latest.current?.draftId === d.draftId) latest.current = d;
    setList((l) => (l ? { ...l, drafts: [d, ...l.drafts.filter((x) => x.draftId !== d.draftId)] } : l));
    setActiveId(d.draftId);
  }, []);

  /** Run a change; on a version conflict, reload and say that the change was not applied. */
  const attempt = useCallback(
    async (run: () => Promise<DraftView>): Promise<string | null> => {
      try {
        put(await run());
        setNotice(null);
        return null;
      } catch (e) {
        if (e instanceof HostError && e.code === "DRAFT_CONFLICT") {
          const text =
            "This draft was changed in another tab or window. It has been reloaded; your last change was not applied, so make it again if you still want it.";
          setNotice({ tone: "warn", text });
          await refresh();
          return text;
        }
        const text = message(e);
        setNotice({ tone: "danger", text });
        return text;
      }
    },
    [put, refresh],
  );
  const change = useCallback(async (run: () => Promise<DraftView>) => (await attempt(run)) === null, [attempt]);

  /** Queue a text save. `run` gets the newest stored draft and returns null when nothing changed. */
  const save = useCallback(
    (field: string, run: (d: DraftView) => Promise<DraftView> | null): Promise<void> => {
      const link = saves.current.then(async () => {
        const d = latest.current;
        if (!d) return;
        const call = run(d);
        const failed = call ? await attempt(() => call) : null;
        const key = `${d.draftId}:${field}`;
        if (failed) unsaved.current.set(key, failed);
        else unsaved.current.delete(key);
      });
      saves.current = link;
      return link;
    },
    [attempt],
  );

  const value = useMemo<DraftsApi>(
    () => ({
      list,
      active,
      notice,
      dismissNotice: () => setNotice(null),
      select: (id) => setActiveId(id),
      newDraft: async () => {
        await change(() => api.drafts.create());
      },
      stage: async (edit) => {
        if (active?.stale) {
          setNotice({
            tone: "warn",
            text: "This draft is based on another model and takes no new edits. Start a new draft.",
          });
          return false;
        }
        return change(async () => {
          const d = active ?? (await api.drafts.create());
          return api.drafts.stage(d.draftId, d.version, edit);
        });
      },
      unstage: async (key) => {
        if (active) await change(() => api.drafts.unstage(active.draftId, active.version, key));
      },
      setRationale: (text) =>
        save("rationale", (d) => (text === d.rationale ? null : api.drafts.rationale(d.draftId, d.version, text))),
      setRequest: (request) =>
        save("request", (d) =>
          JSON.stringify(request) === JSON.stringify(d.request)
            ? null
            : api.drafts.request(d.draftId, d.version, request),
        ),
      settled: async (draftId) => {
        // A save queued while waiting extends the chain; wait until the tail stops moving.
        let tail: Promise<void>;
        do {
          tail = saves.current;
          await tail;
        } while (tail !== saves.current);
        for (const [key, why] of unsaved.current) if (key.startsWith(`${draftId}:`)) return why;
        return null;
      },
      discard: async (id, version) => {
        try {
          await api.drafts.discard(id, version);
          if (id === activeId) setActiveId(null);
          setNotice(null);
        } catch (e) {
          setNotice({ tone: "danger", text: message(e) });
        }
        await refresh();
      },
      staged: (objectId, field) => active?.steps.find((s) => s.objectId === objectId && s.field === field),
    }),
    [list, active, activeId, notice, change, save, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
