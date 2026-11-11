import { useCallback, useEffect, useRef, useState } from "react";
import type { github } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { usePages } from "./usePages";
import { useViewedRefresh } from "./useViewedRefresh";

/** Pin every lazy patch to the selected comparison and discard obsolete responses. */
export function useCodeRead(snapshot: github.PullRequestSnapshot) {
  const { client } = useSession();
  const id = snapshot.summary?.ref?.id ?? "";
  const headSha = snapshot.summary?.headSha ?? "";
  const baseSha = snapshot.baseSha;
  const [commitSha, setCommit] = useState("");
  const [selected, setSelected] = useState<github.PullRequestFile>();
  const [patch, setPatch] = useState<github.PullRequestDiff>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef({ value: 0 });

  const pages = usePages(
    useCallback(
      (cursor: string, refresh: boolean) =>
        client!.api.listPullRequestFiles({ pullRequestId: id, cursor, refresh, headSha, baseSha, commitSha }),
      [client, id, headSha, baseSha, commitSha],
    ),
    id,
  );

  const commits = usePages(
    useCallback(
      (cursor: string, refresh: boolean) => client!.api.listPullRequestCommits({ pullRequestId: id, cursor, refresh }),
      [client, id],
    ),
    id,
  );

  const currentPage = pages.current;
  useViewedRefresh(() => pages.read(false, true));
  const [source, setSource] = useState(currentPage);

  if (source !== currentPage) {
    setSource(currentPage);
    setSelected(undefined);
    setPatch(undefined);
    setBusy(false);
    setError("");
  }

  useEffect(() => {
    const serial = generation.current;
    serial.value++;

    return () => {
      serial.value++;
    };
  }, [currentPage]);

  async function open(file: github.PullRequestFile, force = true) {
    const version = ++generation.current.value;
    setSelected(file);
    setPatch(undefined);
    setError("");
    const load = force || file.patchState === "available";
    setBusy(load);

    if (!load) return;

    try {
      const result = await client!.api.getPullRequestDiff({
        pullRequestId: id,
        headSha,
        baseSha,
        commitSha,
        path: file.path,
        resourceId: String(file.sourcePage),
      });

      if (version === generation.current.value) setPatch(result);
    } catch {
      if (version === generation.current.value)
        setError("Changes updated or unavailable. Refresh the files, then retry.");
    } finally {
      if (version === generation.current.value) setBusy(false);
    }
  }

  function toggle(file: github.PullRequestFile) {
    if (selected?.path !== file.path) {
      void open(file, false);

      return;
    }

    generation.current.value++;
    setSelected(undefined);
    setPatch(undefined);
    setBusy(false);
  }

  return { pages, commits, commitSha, setCommit, selected, patch, busy, error, open, toggle };
}
