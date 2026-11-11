import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { github } from "@canopy/contracts";
import { useSession } from "../../state/session";

export function useGitHubCatalogue(account: github.GitHubAccount, onchanged: () => void) {
  const { client } = useSession();
  const [installations, setInstallations] = useState<github.GitHubInstallation[]>([]);
  const [next, setNext] = useState(0);
  const [busy, setBusy] = useState(account.status === "connected" && account.authKind !== "pat");
  const running = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const [counts, setCounts] = useState<{ installations: number; repositories: number }>();

  function fetchCatalogue(page = 0, refresh = false) {
    if (!client || running.current || account.status !== "connected" || account.authKind === "pat") return;
    running.current = true;

    return client.api
      .listGitHubInstallations({ accountId: account.id, page, refresh })
      .then(
        (value) => {
          setInstallations((previous) => (page ? [...previous, ...value.installations] : value.installations));
          setNext(value.nextPage);
          setCounts({ installations: value.totalCount, repositories: value.repositoryCount });
          setLoaded(true);

          if (!page) setGeneration((n) => n + 1);
        },
        () => {
          setError("Could not refresh GitHub installations. Check access on GitHub, then retry.");
          onchanged();
        },
      )
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  }

  async function load(page = 0, refresh = false) {
    if (!client || running.current || account.status !== "connected" || account.authKind === "pat") return;
    setBusy(true);
    setError("");
    await fetchCatalogue(page, refresh);
  }

  async function disconnect() {
    if (!client) return;
    setBusy(true);

    try {
      await client.api.disconnectGitHubAccount({ accountId: account.id });
      onchanged();
    } catch {
      setError("Could not disconnect this account. Check the connection, then retry.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void fetchCatalogue();

    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void load(0, true);
    });

    const timer = setInterval(() => {
      if (AppState.currentState === "active") void load();
    }, 900_000);

    return () => {
      listener.remove();
      clearInterval(timer);
    };
    // Remounting on account revision resets the catalogue; ordinary renders preserve open repositories.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, account.id, account.revision]);

  return {
    installations,
    next,
    busy,
    loaded,
    error,
    generation,
    load,
    disconnect,
    setError,
    installationCount: counts?.installations ?? account.installationCount,
    repositoryCount: counts?.repositories ?? account.repositoryCount,
  };
}
