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
  /** Save a draft's rationale. The draft is named by the caller, so a later switch cannot redirect it. */
  setRationale(draftId: string, text: string): Promise<void>;
  setRequest(draftId: string, request: DraftRequest): Promise<void>;
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
  // Text saves (rationale, request) run one after another, so a second blur does not race the
  // first. `saves` is the tail of that chain. `unsaved` holds, per draft and field, why its last
  // save was not stored; the field's next stored (or unchanged) save clears it. `stored` is the
  // newest known state of every draft, by ID, updated as soon as a host answer arrives (before
  // React renders it).
  //
  // A save is sent on the version the edit was made on, advanced only across this tab's own
  // acknowledged writes (`acked`: draft ID -> version written on -> version it produced). A
  // version this tab only learned from a reload (another tab's write) is never used for an edit
  // made before it, so that edit gets an explicit conflict instead of overwriting the other tab.
  const saves = useRef<Promise<void>>(Promise.resolve());
  const unsaved = useRef(new Map<string, string>());
  const stored = useRef(new Map<string, DraftView>());
  const acked = useRef(new Map<string, Map<number, number>>());
  /** Send one of this tab's writes on `version`, recording what it produced. */
  const mine = useCallback(async (draftId: string, version: number, call: Promise<DraftView>) => {
    const d = await call;
    const chain = acked.current.get(draftId) ?? new Map<number, number>();
    chain.set(version, d.version);
    acked.current.set(draftId, chain);
    return d;
  }, []);
  /** `version`, moved forward across this tab's own acknowledged writes to the draft. */
  const ownVersion = useCallback((draftId: string, version: number) => {
    const chain = acked.current.get(draftId);
    let v = version;
    for (let next = chain?.get(v); next !== undefined && next > v; next = chain?.get(v)) v = next;
    return v;
  }, []);
  const know = useCallback((d: DraftView) => {
    const had = stored.current.get(d.draftId);
    if (!had || had.version <= d.version) stored.current.set(d.draftId, d);
  }, []);

  const refresh = useCallback(async () => {
    if (!projectId) return setList(null);
    const mine = ++seq.current;
    try {
      const next = await api.drafts.list();
      if (mine !== seq.current) return;
      // A reload is the host's word: it replaces what is known, older versions included.
      stored.current = new Map(next.drafts.map((d) => [d.draftId, d]));
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

  /** Put one draft's new state into the list; `select` also makes it this tab's draft. */
  const put = useCallback(
    (d: DraftView, select: boolean) => {
      know(d);
      setList((l) => {
        if (!l) return l;
        const now = l.drafts.find((x) => x.draftId === d.draftId);
        // An older answer arriving late never replaces a newer state.
        if (now && now.version > d.version) return l;
        return { ...l, drafts: [d, ...l.drafts.filter((x) => x.draftId !== d.draftId)] };
      });
      if (select) setActiveId(d.draftId);
    },
    [know],
  );

  /**
   * Run a change; on a version conflict, reload and say that the change was not applied.
   * A text save does not select its draft (the user may have moved to another one meanwhile) and
   * leaves clearing the message to the save queue.
   */
  const attempt = useCallback(
    async (run: () => Promise<DraftView>, select = true): Promise<string | null> => {
      try {
        put(await run(), select);
        if (select) setNotice(null);
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

  /**
   * Queue a text save for one named draft. `run` gets that draft's newest stored state, to skip
   * a save that changes nothing (null), and the version to send it on.
   */
  const save = useCallback(
    (
      draftId: string,
      field: string,
      run: (d: DraftView, version: number) => Promise<DraftView> | null,
    ): Promise<void> => {
      // The version the edit was made on: what this tab knew when the field was left.
      const basis = stored.current.get(draftId)?.version;
      const link = saves.current.then(async () => {
        const d = stored.current.get(draftId);
        if (!d || basis === undefined) return; // discarded meanwhile
        const version = ownVersion(draftId, basis);
        const call = run(d, version);
        const failed = call ? await attempt(() => mine(draftId, version, call), false) : null;
        const key = `${draftId}:${field}`;
        if (failed) unsaved.current.set(key, failed);
        else {
          unsaved.current.delete(key);
          // Clear the message only once no text save is left unstored.
          if (unsaved.current.size === 0) setNotice(null);
        }
      });
      saves.current = link;
      return link;
    },
    [attempt, mine, ownVersion],
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
          return mine(d.draftId, d.version, api.drafts.stage(d.draftId, d.version, edit));
        });
      },
      unstage: async (key) => {
        if (active)
          await change(() =>
            mine(active.draftId, active.version, api.drafts.unstage(active.draftId, active.version, key)),
          );
      },
      setRationale: (draftId, text) =>
        save(draftId, "rationale", (d, version) =>
          text === d.rationale ? null : api.drafts.rationale(draftId, version, text),
        ),
      setRequest: (draftId, request) =>
        save(draftId, "request", (d, version) =>
          JSON.stringify(request) === JSON.stringify(d.request) ? null : api.drafts.request(draftId, version, request),
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
    [list, active, activeId, notice, change, save, mine, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
