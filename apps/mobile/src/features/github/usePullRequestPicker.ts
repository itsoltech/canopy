import { useEffect, useRef, useState } from "react";
import type { github } from "@canopy/contracts";
import { GITHUB_HOME, splitId } from "@canopy/domain/computers";
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

  async function link(pr: github.RepositoryPullRequest) {
    if (!client || !data || linking.current || pr.linked) return;
    linking.current = true;
    const current = epoch.current;
    setBusy(true);
    setError("");

    try {
      onlinked(
        await client.api.linkThreadPullRequest({
          threadId,
          url: `https://github.com/${data.repositoryName}/pull/${pr.number}`,
          expectedRevision: revision,
        }),
      );
      setData((previous) =>
        previous && epoch.current === current
          ? {
              ...previous,
              items: previous.items.map((p) => (p.number === pr.number ? { ...p, linked: true } : p)),
            }
          : previous,
      );
    } catch {
      setError("Could not link this pull request. Refresh the list, then retry.");
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

  return { data, query, setQuery, filter, setFilter, loading, busy, error, reload, more, link, choose, homeId };
}

async function pickerRead(
  client: NonNullable<ReturnType<typeof useSession>["client"]>,
  threadId: string,
  query: string,
  filter: string,
  cursor = "",
) {
  const request = {
    threadId,
    query: query.trim().startsWith("https://") ? "" : query,
    includeClosed: filter === "all",
    cursor,
  };

  const value = await client.api.listRepositoryPullRequests(request);
  const candidate = value.selection?.candidates.find((account) => account.authKind === "device");

  if (cursor || value.state !== "choose_account" || !candidate || !value.selection) return value;
  const node = splitId(threadId).node;
  await client.api
    .setGitHubRepositoryAccount({
      homeId: node ? `${GITHUB_HOME}~${node}` : "",
      repositoryName: value.repositoryName,
      accountId: candidate.id,
      expectedRevision: value.selection.revision,
    })
    .catch(() => {});

  return client.api.listRepositoryPullRequests(request);
}
