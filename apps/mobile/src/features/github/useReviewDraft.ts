import { useCallback, useEffect, useRef, useState } from "react";
import type { github } from "@canopy/contracts";
import { reviewComplete, reviewRevision } from "@canopy/domain/github-review";
import { useSession } from "../../state/session";
import { useViewedRefresh } from "./useViewedRefresh";
import { invalidations } from "./invalidations";

export function useReviewDraft(snapshot: github.PullRequestSnapshot) {
  const { client } = useSession();

  const id = snapshot.summary?.ref?.id ?? "",
    headSha = snapshot.summary?.headSha ?? "";

  const [pages, setPages] = useState<github.PullRequestReviewDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(pages);
  const serial = useRef({ value: 0 });
  const loading = useRef(false);

  useEffect(() => {
    current.current = pages;
  }, [pages]);

  const read = useCallback(
    async (more = false) => {
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
          refresh: true,
        });

        if (version === serial.current.value)
          setPages((previous) =>
            more
              ? [...previous, value]
              : previous[0]?.revision === value.revision
                ? [value, ...previous.slice(1)]
                : [value],
          );
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
    [client, id, headSha],
  );

  useEffect(() => {
    const generation = serial.current;
    loading.current = false;
    void read();
    const unsubscribe = invalidations.subscribe(`${id}:reviews`, () => void read());

    return () => {
      generation.value++;
      loading.current = false;
      unsubscribe();
    };
  }, [read, id]);
  useViewedRefresh(() => read());

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
