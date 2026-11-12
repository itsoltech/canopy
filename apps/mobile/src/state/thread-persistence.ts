import { useEffect, useMemo, useRef, useState } from "react";
import type { ui } from "@canopy/contracts";
import { useSession } from "./session";
import { mobileCacheLoaded } from "../features/settings/client-diagnostics";

/** Each thread owns its cache load, save timer and reset fence. */
export function useThreadPersistence(id: string) {
  const { threadCache, active } = useSession();
  const current = useMemo(() => ({ current: threadCache?.peek(id) }), [id, threadCache]);
  const [state, setState] = useState({ id, snapshot: current.current, loaded: false });
  const saving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snapshot = state.id === id ? state.snapshot : current.current;
  const setSnapshot = (next: ui.ThreadSnapshot | undefined) => setState({ id, snapshot: next, loaded: true });
  useEffect(() => {
    let cancelled = false;
    void (threadCache?.load(id) ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then((cached) => {
        if (cancelled) return;

        if (cached?.thread) mobileCacheLoaded();
        current.current = cached ?? current.current;
        setState({ id, snapshot: current.current, loaded: true });
      });

    return () => {
      cancelled = true;
    };
  }, [id, threadCache, current]);
  useEffect(() => {
    if (!snapshot || !threadCache || saving.current) return;
    saving.current = setTimeout(() => {
      saving.current = undefined;

      if (current.current?.syncCursor) void threadCache.save(current.current).catch(() => {});
    }, 2000);
  }, [snapshot, threadCache, current]);
  useEffect(() => {
    const save = () => {
      clearTimeout(saving.current);
      saving.current = undefined;

      if (current.current?.syncCursor) void threadCache?.save(current.current).catch(() => {});
    };

    if (!active) save();

    return save;
  }, [active, threadCache, current]);

  return {
    snapshot,
    current,
    setSnapshot,
    loaded: state.id === id && state.loaded,
    reset() {
      clearTimeout(saving.current);
      saving.current = undefined;

      if (current.current) current.current = { ...current.current, cursor: "", syncCursor: undefined };
      void threadCache?.remove(id);
    },
  };
}
