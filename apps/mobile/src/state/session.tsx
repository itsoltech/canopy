import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { addNetworkStateListener, useNetworkState } from "expo-network";
import { routedMobileClient } from "../api/routes";
import { pinnedTransport } from "../api/pinned";
import { SessionPersistence, type DeviceSession } from "../storage/session";
import { prepareThreadCache } from "../storage/thread-cache-native";
import { prepareArchivedCache } from "../storage/archived-cache-native";
import type { PersistentArchivedCache } from "../storage/archived-cache";
import { type PersistentThreadCache } from "../storage/thread-cache";
import { prepareBotCache } from "../storage/bot-cache-native";
import { clearPairedHistory, type PersistentBotCache } from "../storage/bot-cache";
import { prepareImageCache } from "../storage/image-cache-native";
import type { ImmutableImageCache } from "../storage/image-cache";
import { bots as botContract } from "@canopy/contracts";
import { ModelCatalogCache } from "../features/models/catalog-cache";
import { QueryCache } from "@canopy/domain/shared-query";
import { startMobileDiagnostics } from "../features/settings/client-diagnostics";
import { clearDiagnosticLogs } from "../features/settings/diagnostics-log-file";
import { useWorkspaceStore, forgetWorkspace } from "../features/workspace/store";
import { prepareMobileDrafts } from "../features/drafts/storage";
import type { MobileDrafts } from "../features/drafts/store";

const SHARED_READ_FAILED = "Could not load settings. Check the connection and retry.";

/** Without a pairing nothing reads. */
const unpaired = new QueryCache();

unpaired.dispose();

function useSessionState() {
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [ready, setReady] = useState(false);
  const [drafts, setDrafts] = useState<MobileDrafts | null>(null);
  const [threadCache, setThreadCache] = useState<PersistentThreadCache | null>(null);
  const [archivedCache, setArchivedCache] = useState<PersistentArchivedCache | null>(null);
  const [botCache, setBotCache] = useState<PersistentBotCache | null>(null);
  const [imageCache, setImageCache] = useState<ImmutableImageCache | null>(null);
  const [bots, setBots] = useState<botContract.Bot[]>([]);
  const [error, setError] = useState("");
  const [persistence] = useState(() => new SessionPersistence());
  const [active, setActive] = useState(AppState.currentState !== "background");
  const [epoch, setEpoch] = useState(0);
  const network = useNetworkState();

  const updateBots = useCallback(
    (list: botContract.Bot[]) => {
      setBots(list);
      void botCache?.reconcile(list).catch(() => {});
    },
    [botCache],
  );

  useEffect(() => {
    void persistence
      .load()
      .then(async (value) => {
        setDrafts(await prepareMobileDrafts(value));
        setThreadCache(await prepareThreadCache(value));
        setArchivedCache(await prepareArchivedCache(value));
        setBotCache(await prepareBotCache(value));
        setImageCache(await prepareImageCache(value));
        setSession(value);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Could not read secure storage. Pair this phone again."),
      )
      .finally(() => setReady(true));
  }, [persistence]);

  const client = usePairedClient(session, persistence, setError);
  const workspace = useWorkspaceStore(client, session);
  useEffect(() => (client ? startMobileDiagnostics(client.api) : undefined), [client]);
  useEffect(() => {
    if (!client || !drafts || !active) return;
    const controller = new AbortController();
    void drafts.watch(client.api, controller.signal);

    return () => controller.abort();
  }, [client, drafts, active, epoch]);

  const modelCatalog = useMemo(() => new ModelCatalogCache(client?.api), [client]);
  // Reads shared by every screen of this pairing; a new pairing or unpair fences the old one's requests.
  const { queries, searches } = useSessionQueries(client);

  useSessionConnections(client, setActive, setEpoch);

  async function clearHistory(revoked = false) {
    workspace.clear();
    forgetWorkspace(session);
    await drafts?.close();
    await prepareMobileDrafts(null);
    setDrafts(null);
    clearDiagnosticLogs();

    const cleared = await clearPairedHistory([threadCache, botCache, archivedCache, imageCache], () =>
      persistence.forget(),
    );

    setThreadCache(null);
    setArchivedCache(null);
    setBotCache(null);
    setImageCache(null);
    setBots([]);
    setSession(null);
    setError(historyMessage(cleared, revoked));
  }

  return {
    drafts,
    session,
    client,
    modelCatalog,
    queries,
    searches,
    workspace,
    threadCache,
    archivedCache,
    botCache,
    imageCache,
    bots,
    updateBots,
    ready,
    error,
    active,
    /** Changes when the network does; live streams subscribe again. */
    epoch,
    reconnect: () => resetSession(client, () => setEpoch((n) => n + 1)),
    // A private tailnet gateway may be reachable even when public internet probes fail.
    online: network.isConnected !== false,
    async pair(value: DeviceSession) {
      await drafts?.close();
      setDrafts(await prepareMobileDrafts(value));
      await threadCache?.close();
      await archivedCache?.close();
      await botCache?.close();
      await imageCache?.close();
      const cache = await prepareThreadCache(value);
      const archive = await prepareArchivedCache(value);
      const botHistory = await prepareBotCache(value);
      const images = await prepareImageCache(value);
      await persistence.save(value);
      setThreadCache(cache);
      setArchivedCache(archive);
      setBotCache(botHistory);
      setImageCache(images);
      setBots([]);
      setSession(value);
      setError("");
    },
    forget: () => clearHistory(),
    expired: () => clearHistory(true),
  };
}

function useSessionQueries(client: ReturnType<typeof routedMobileClient> | null) {
  const queries = useMemo(() => (client ? new QueryCache({ failure: () => SHARED_READ_FAILED }) : unpaired), [client]);
  // Recent mention searches never push shared reads out of the LRU.
  const searches = useMemo(() => (client ? new QueryCache({ idle: 64 }) : unpaired), [client]);
  useEffect(() => () => queries.dispose(), [queries]);
  useEffect(() => () => searches.dispose(), [searches]);

  return { queries, searches };
}

function historyMessage(cleared: boolean, revoked: boolean) {
  if (!cleared)
    return revoked
      ? "This device was revoked. Could not clear local storage. Clear Canopy’s app data before pairing again."
      : "Could not clear local storage. Clear Canopy’s app data before pairing again.";

  return revoked ? "This device was revoked. Create a new code in Settings → Devices on a paired device." : "";
}

/** Reset pooled connections inside the event, before React restarts foreground streams. */
function useSessionConnections(
  client: ReturnType<typeof routedMobileClient> | null,
  setActive: (active: boolean) => void,
  setEpoch: (update: (n: number) => number) => void,
) {
  useEffect(() => {
    let suspended = AppState.currentState === "background";
    let path = "";

    const app = AppState.addEventListener("change", (next) => {
      if (next === "background") suspended = true;

      if (next === "active" && suspended) {
        suspended = false;
        client?.reset();
      }

      setActive(next === "active");
    });

    const network = addNetworkStateListener((event) => {
      // Reachability also catches Android VPN changes with identical Wi-Fi/cellular state.
      const next = `${event.type}:${event.isConnected}:${event.isInternetReachable}`;

      if (path && path !== next) {
        client?.reset();
        setEpoch((n) => n + 1);
      }

      path = next;
    });

    return () => {
      app.remove();
      network.remove();
    };
  }, [client, setActive, setEpoch]);
}

function usePairedClient(
  session: DeviceSession | null,
  persistence: SessionPersistence,
  setError: (error: string) => void,
) {
  return useMemo(
    () =>
      session
        ? routedMobileClient({
            connection: session,
            token: session.token,
            transport: pinnedTransport,
            changed(connection) {
              void persistence
                .update(session.deviceId, connection)
                .catch(() => setError("Could not save the latest network addresses. Reconnect and try again."));
            },
          })
        : null,
    [session, persistence, setError],
  );
}

function resetSession(client: ReturnType<typeof routedMobileClient> | null, advance: () => void) {
  client?.reset();
  advance();
}

const Context = createContext<ReturnType<typeof useSessionState> | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useSessionState()}>{children}</Context.Provider>;
}

export function useSession() {
  const value = useContext(Context);

  if (!value) throw new Error("Missing SessionProvider");

  return value;
}
