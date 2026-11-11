import { useEffect, useRef, useState } from "react";
import type { github } from "@canopy/contracts";
import { invalidations } from "./invalidations";

export function usePages<T extends { page?: github.PullRequestPageInfo }>(
  load: (cursor: string, refresh: boolean) => Promise<T>,
  id = "",
  secondaryId = "",
  retainOnInvalidation = false,
) {
  const [pages, setPages] = useState<T[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const loading = useRef(false);
  const latest = useRef(() => {});
  latest.current = () => {
    generation.current++;
    loading.current = false;
    void read(false, true, true);
  };

  useEffect(() => (id ? invalidations.subscribe(id, () => latest.current()) : undefined), [id]);
  useEffect(
    () => (secondaryId ? invalidations.subscribe(secondaryId, () => latest.current()) : undefined),
    [secondaryId],
  );

  useEffect(() => {
    const version = ++generation.current;
    setPages([]);
    setIndex(0);
    setBusy(true);
    setError("");
    loading.current = true;
    void load("", false)
      .then((value) => {
        if (generation.current === version) setPages([value]);
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
  }, [load]);

  async function read(next = false, refresh = false, reset = false) {
    if (loading.current) return;
    const version = generation.current;
    loading.current = true;
    setBusy(true);
    setError("");

    if (reset) {
      setPages(retainOnInvalidation && pages[index] ? [pages[index]] : []);
      setIndex(0);
    }

    try {
      const cursor = reset
        ? ""
        : next
          ? (pages[index]?.page?.nextCursor ?? "")
          : index
            ? (pages[index - 1]?.page?.nextCursor ?? "")
            : "";

      const value = await load(cursor, refresh);

      if (version !== generation.current) return;
      setPages(
        reset
          ? [value]
          : next
            ? [...pages.slice(0, index + 1), value]
            : [...pages.slice(0, index), value, ...pages.slice(index + 1)],
      );

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
    previous: index ? () => setIndex(index - 1) : undefined,
  };
}
