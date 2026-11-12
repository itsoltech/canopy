import { useCallback, useEffect, useRef, useState } from "react";
import type { github } from "@canopy/contracts";
import { reviewComplete, reviewRevision } from "@canopy/domain/github-review";
import { useSession } from "../../state/session";
import { useViewedRefresh } from "./useViewedRefresh";
import { invalidations } from "./invalidations";

export function useReviewDraft(snapshot: github.PullRequestSnapshot) {
  const { client, queries } = useSession();

  const id = snapshot.summary?.ref?.id ?? "",
    headSha = snapshot.summary?.headSha ?? "";

  const key = `ReviewDraft:${snapshot.accountId}:${snapshot.accessRevision}:${id}:${headSha}`;

  const [pages, setPages] = useState<github.PullRequestReviewDraft[]>(
    () => queries.snapshot<github.PullRequestReviewDraft[]>(key).data ?? [],
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(pages);
  const serial = useRef({ value: 0 });
  const loading = useRef(false);

  useEffect(() => {
    current.current = pages;
  }, [pages]);

  const read = useCallback(
    async (more = false, refresh = true) => {
      if (loading.current || !client) return;
      const version = serial.current.value;
      loading.current = true;
      setBusy(true);
      setError("");

      try {
        const value = await client.api.getPullRequestReviewDraft({
          pullRequestId: id,
          headSha,
          cursor: more ? (current.current.at(-1)?.page?.nextCursor ?? "") : "",
          refresh,
        });

        if (version === serial.current.value) {
          const previous = current.current;

          const updated = more
            ? [...previous, value]
            : previous[0]?.revision === value.revision
              ? [value, ...previous.slice(1)]
              : [value];

          current.current = updated;
          setPages(updated);
          queries.set(key, updated);

          return true;
        }
      } catch {
        if (version === serial.current.value)
          setError("Could not load the pending review. Refresh and check account access.");
      } finally {
        if (version === serial.current.value) {
          loading.current = false;
          setBusy(false);
        }
      }
    },
    [client, queries, key, id, headSha],
  );

  useEffect(() => {
    const generation = serial.current;
    const cached = queries.snapshot<github.PullRequestReviewDraft[]>(key).data ?? [];
    current.current = cached;
    setPages(cached);
    loading.current = false;
    void read(false, false);
    const unsubscribe = invalidations.subscribe(`${id}:reviews`, () => void read(false, false));
    const manual = invalidations.subscribe(id, () => void read());

    return () => {
      generation.value++;
      loading.current = false;
      unsubscribe();
      manual();
    };
  }, [read, id, queries, key]);
  useViewedRefresh(async () => {
    await read(false, false);
  });

  return {
    pages,
    busy,
    error,
    read,
    id,
    pendingId: pages[0]?.id ?? "",
    count: pages[0]?.totalCount ?? 0,
    complete: !busy && !error && reviewComplete(pages),
    revision: reviewRevision(pages),
    refresh: () => read(),
  };
}

export type ReviewDraft = ReturnType<typeof useReviewDraft>;
