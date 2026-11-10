import { useEffect, useRef, useState } from "react";
import type { github } from "@canopy/contracts";
import { useSession } from "../../state/session";

export function useGitHubRepositories(accountId: string, installationId: string) {
  const { client } = useSession();
  const [repos, setRepos] = useState<github.GitHubRepository[]>([]);
  const [next, setNext] = useState(0);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const running = useRef(false);

  function fetchPages(remaining = false) {
    if (!client || running.current) return;
    running.current = true;

    let page = remaining ? next : 0;

    return client.api
      .listGitHubRepositories({ accountId, installationId, page })
      .then(async (first) => {
        let value = first;

        for (;;) {
          const append = page > 0;
          const repositories = value.repositories;
          setRepos((previous) => (append ? [...previous, ...repositories] : repositories));
          setNext(value.nextPage);
          setTotal(value.totalCount);
          page = value.nextPage;

          if (!remaining || !page) break;

          value = await client.api.listGitHubRepositories({ accountId, installationId, page });
        }
      })
      .catch(() => setError("Could not load repositories. Check access on GitHub, then retry."))
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  }

  useEffect(() => {
    void fetchPages();
    // The installation is keyed by its account catalogue generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, accountId, installationId]);

  function load(remaining = false) {
    if (running.current) return;
    setBusy(true);
    setError("");
    void fetchPages(remaining);
  }

  return { repos, next, total, busy, error, load };
}
