import { useCallback, useEffect, useRef, useState } from "react";
import type { github } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { usePages } from "./usePages";

interface CodeView {
  commitSha: string;
  selected?: github.PullRequestFile;
  patch?: github.PullRequestDiff;
}

/** Pin every lazy patch to the selected comparison and discard obsolete responses. */
export function useCodeRead(snapshot: github.PullRequestSnapshot) {
  const { client, queries } = useSession();
  const id = snapshot.summary?.ref?.id ?? "";
  const headSha = snapshot.summary?.headSha ?? "";
  const baseSha = snapshot.baseSha;
  const key = `CodeView:${snapshot.accountId}:${snapshot.accessRevision}:${id}:${headSha}:${baseSha}`;
  const saved = queries.snapshot<CodeView>(key).data;
  const [commitSha, setCommit] = useState(saved?.commitSha ?? "");
  const [selected, setSelected] = useState<github.PullRequestFile | undefined>(saved?.selected);
  const [patch, setPatch] = useState<github.PullRequestDiff | undefined>(saved?.patch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef({ value: 0 });
  const comparison = useRef(`${key}:${commitSha}`);

  useEffect(() => {
    queries.set(key, { commitSha, selected, patch });
  }, [queries, key, commitSha, selected, patch]);

  const pages = usePages(
    useCallback(
      (cursor: string, refresh: boolean) =>
        client!.api.listPullRequestFiles({ pullRequestId: id, cursor, refresh, headSha, baseSha, commitSha }),
      [client, id, headSha, baseSha, commitSha],
    ),
    id,
    "",
    true,
    `files:${snapshot.accountId}:${snapshot.accessRevision}:${headSha}:${baseSha}:${commitSha}`,
  );

  const commits = usePages(
    useCallback(
      (cursor: string, refresh: boolean) => client!.api.listPullRequestCommits({ pullRequestId: id, cursor, refresh }),
      [client, id],
    ),
    id,
    "",
    false,
    `commits:${snapshot.accountId}:${snapshot.accessRevision}:${headSha}`,
  );

  const currentPage = pages.current;
  const [source, setSource] = useState(currentPage);

  if (source !== currentPage) {
    setSource(currentPage);
    const file = currentPage?.files.find((f) => f.path === selected?.path);

    if (!file || (patch && patch.page?.headSha !== currentPage?.page?.headSha)) {
      setSelected(undefined);
      setPatch(undefined);
      setBusy(false);
      setError("");
    } else setSelected(file);
  }

  useEffect(() => {
    const serial = generation.current;
    serial.value++;
    const next = `${key}:${commitSha}`;

    if (comparison.current !== next) {
      comparison.current = next;
      setSelected(undefined);
      setPatch(undefined);
      setBusy(false);
      setError("");
    }

    return () => {
      serial.value++;
    };
  }, [key, commitSha]);

  async function open(file: github.PullRequestFile, force = true) {
    const version = ++generation.current.value;

    if (selected?.path !== file.path) setPatch(undefined);
    setSelected(file);
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
