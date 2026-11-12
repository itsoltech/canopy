import { useEffect, useRef, useState } from "react";
import type { github } from "@canopy/contracts";
import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
import type { PullRequestPickerItem } from "@canopy/domain/github-pr-picker";
import { useSession } from "../../state/session";

export function usePullRequestPicker(
  threadId: string,
  visible: boolean,
  revision: bigint,
  onlinked: (value: github.ThreadPullRequestsResponse) => void,
) {
  const { client } = useSession();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("open");
  const [data, setData] = useState<github.RepositoryPullRequestsResponse>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A failed direct link can continue through the repository access form.
  const [url, setUrl] = useState("");
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const linking = useRef(false);
  const paging = useRef(false);
  const node = splitId(threadId).node;
  const homeId = node ? `${GITHUB_HOME}~${node}` : "";
  const reload = () => setRetry((value) => value + 1);

  useEffect(() => {
    const current = ++epoch.current;

    if (!client || !visible) return;
    setLoading(true);
    setError("");
    setUrl("");
    setData((previous) => previous && { ...previous, items: [], nextCursor: "" });

    const timer = setTimeout(
      () => {
        void pickerRead(client, threadId, query, filter)
          .then((value) => {
            if (epoch.current === current) setData(value);
          })
          .catch(() => {
            if (epoch.current === current) setError("Could not load pull requests. Check the connection, then retry.");
          })
          .finally(() => {
            if (epoch.current === current) setLoading(false);
          });
      },
      query ? 250 : 0,
    );

    return () => {
      clearTimeout(timer);

      if (epoch.current === current) epoch.current++;
    };
  }, [client, threadId, visible, query, filter, retry]);

  async function more() {
    if (!client || !data?.nextCursor || loading || paging.current) return;
    const current = epoch.current;
    paging.current = true;
    setLoading(true);

    try {
      const page = await pickerRead(client, threadId, query, filter, data.nextCursor);

      if (epoch.current === current)
        setData({
          ...page,
          items:
            page.state === "ready"
              ? [...data.items, ...page.items.filter((p) => !data.items.some((old) => old.number === p.number))]
              : [],
        });
    } catch {
      if (epoch.current === current) setError("Could not load more pull requests. Retry the list.");
    } finally {
      paging.current = false;

      if (epoch.current === current) setLoading(false);
    }
  }

  async function link(item: PullRequestPickerItem) {
    if (!client || linking.current || item.linked) return;
    linking.current = true;
    const current = epoch.current;
    setBusy(true);
    setError("");
    setUrl("");

    try {
      const request = { threadId, url: item.url, expectedRevision: revision };
      onlinked(await client.api.linkThreadPullRequest(request));

      if (!item.pr && current === epoch.current) {
        setQuery("");
        reload();
      } else
        setData((previous) =>
          previous && epoch.current === current
            ? {
                ...previous,
                items: previous.items.map((p) => (p.number === item.pr?.number ? { ...p, linked: true } : p)),
              }
            : previous,
        );
    } catch {
      setError("Could not link this pull request. Refresh the list, then retry.");

      if (!item.pr && current === epoch.current) setUrl(item.url);
    } finally {
      linking.current = false;
      setBusy(false);
    }
  }

  async function choose(accountId: string) {
    if (!client || !data?.selection || busy) return;
    setBusy(true);

    try {
      await client.api.setGitHubRepositoryAccount({
        homeId,
        repositoryName: data.repositoryName,
        accountId,
        expectedRevision: data.selection.revision,
      });
      reload();
    } catch {
      setError("Could not choose this account. Check repository access, then retry.");
    } finally {
      setBusy(false);
    }
  }

  return { data, query, setQuery, filter, setFilter, loading, busy, error, url, reload, more, link, choose, homeId };
}

function pickerRead(
  client: NonNullable<ReturnType<typeof useSession>["client"]>,
  threadId: string,
  query: string,
  filter: string,
  cursor = "",
) {
  return client.api.listRepositoryPullRequests({
    threadId,
    query: query.trim().startsWith("https://") ? "" : query,
    includeClosed: filter === "all",
    cursor,
  });
}
