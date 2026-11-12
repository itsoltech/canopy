import { useEffect, useRef, useState } from "react";
import type { github } from "@canopy/contracts";
import { invalidations } from "./invalidations";
import { useSession } from "../../state/session";

interface SavedPages<T> {
  pages: T[];
  index: number;
}

export function usePages<T extends { page?: github.PullRequestPageInfo }>(
  load: (cursor: string, refresh: boolean) => Promise<T>,
  id = "",
  secondaryId = "",
  retainOnInvalidation = false,
  cacheKey = "",
) {
  const { queries } = useSession();
  const key = `PullRequestPages:${id}:${cacheKey}`;
  const saved = cacheKey ? queries.snapshot<SavedPages<T>>(key).data : undefined;
  const [pages, setPages] = useState<T[]>(saved?.pages ?? []);
  const [index, setIndex] = useState(saved?.index ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const loading = useRef(false);
  const latest = useRef<(refresh?: boolean) => void>(() => {});
  latest.current = (refresh = true) => {
    generation.current++;
    loading.current = false;
    void read(false, refresh, true);
  };

  useEffect(() => (id ? invalidations.subscribe(id, () => latest.current()) : undefined), [id]);
  const resource = cacheKey.split(":")[0];
  useEffect(
    () => (id && resource ? invalidations.subscribe(`${id}:${resource}`, () => latest.current(false)) : undefined),
    [id, resource],
  );
  useEffect(
    () =>
      secondaryId && secondaryId !== `${id}:${resource}`
        ? invalidations.subscribe(secondaryId, () => latest.current(false))
        : undefined,
    [secondaryId, id, resource],
  );

  useEffect(() => {
    const version = ++generation.current;
    const cached = cacheKey ? queries.snapshot<SavedPages<T>>(key).data : undefined;
    const previous = cached?.pages ?? [];
    const at = cached?.index ?? 0;
    setPages(previous);
    setIndex(at);
    setBusy(true);
    setError("");
    loading.current = true;
    void load(at ? (previous[at - 1]?.page?.nextCursor ?? "") : "", false)
      .then((value) => {
        if (generation.current === version) {
          const next = [...previous.slice(0, at), value, ...previous.slice(at + 1)];
          setPages(next);

          if (cacheKey) queries.set(key, { pages: next, index: at });
        }
      })
      .catch(() => {
        if (generation.current === version) setError("Could not load this page. Refresh the pull request, then retry.");
      })
      .finally(() => {
        if (generation.current === version) {
          setBusy(false);
          loading.current = false;
        }
      });

    return () => {
      generation.current++;
      loading.current = false;
    };
  }, [load, queries, key, cacheKey]);

  async function read(next = false, refresh = false, reset = false) {
    if (loading.current) return;
    const version = generation.current;
    loading.current = true;
    setBusy(true);
    setError("");

    try {
      const cursor = (next ? pages[index] : pages[index - 1])?.page?.nextCursor ?? "";

      let updated = [...pages];
      const first = reset && !retainOnInvalidation ? 0 : next ? index + 1 : index;
      const last = reset && !retainOnInvalidation ? Math.max(0, pages.length - 1) : first;

      for (let at = first; at <= last; at++) {
        const position =
          at === first && !(reset && !retainOnInvalidation)
            ? cursor
            : at
              ? (updated[at - 1]?.page?.nextCursor ?? "")
              : "";

        const value = await load(position, refresh);

        if (version !== generation.current) return;
        updated = [...updated.slice(0, at), value, ...updated.slice(at + 1)];
        setPages(updated);

        if (cacheKey) queries.set(key, { pages: updated, index: next ? index + 1 : index });

        if (!value.page?.nextCursor) break;
      }

      if (next) setIndex(index + 1);
    } catch {
      if (version === generation.current) setError("Could not load this page. Refresh the pull request, then retry.");
    } finally {
      if (version === generation.current) {
        setBusy(false);
        loading.current = false;
      }
    }
  }

  return {
    pages,
    index,
    current: pages[index],
    busy,
    error,
    read,
    previous: index
      ? () => {
          setIndex(index - 1);

          if (cacheKey) queries.set(key, { pages, index: index - 1 });
        }
      : undefined,
  };
}
