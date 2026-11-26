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

  /** Put one draft's new state into the list. */
  const put = useCallback((d: DraftView) => {
    setList((l) => (l ? { ...l, drafts: [d, ...l.drafts.filter((x) => x.draftId !== d.draftId)] } : l));
    setActiveId(d.draftId);
  }, []);

  /** Run a change; on a version conflict, reload and say that the change was not applied. */
  const change = useCallback(
    async (run: () => Promise<DraftView>) => {
      try {
        put(await run());
        setNotice(null);
        return true;
      } catch (e) {
        if (e instanceof HostError && e.code === "DRAFT_CONFLICT") {
          setNotice({
            tone: "warn",
            text: "This draft was changed in another tab or window. It has been reloaded; your last change was not applied, so make it again if you still want it.",
          });
          await refresh();
        } else setNotice({ tone: "danger", text: message(e) });
        return false;
      }
    },
    [put, refresh],
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
      setRationale: async (text) => {
        if (active && text !== active.rationale)
          await change(() => api.drafts.rationale(active.draftId, active.version, text));
      },
      setRequest: async (request) => {
        if (active && JSON.stringify(request) !== JSON.stringify(active.request))
          await change(() => api.drafts.request(active.draftId, active.version, request));
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
    [list, active, activeId, notice, change, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
