import { useContext, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { confirm } from "../../ui/Confirm";
import type { Client } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Button, Notice, SheetContent } from "../../ui/components";
import { SkeletonScope } from "../../ui/Skeleton";

export type SettingsApi = Client<typeof ui.GatewayService>;

/** How old a shared settings read may be when a screen opens; events refresh it sooner. */
const SETTINGS_MAX_AGE_MS = 30_000;

/**
 * A settings read shared by every screen of the pairing. `key` names the request: the RPC name, then its scope
 * (`GetComputers`, `ListModels:<worker>`). Screens with the same key share one value and one request; overview
 * events and linked reads that settle invalidate it by name. A screen opened later reuses a value read in the
 * last 30 s. A mutation reads only this resource again; projects, workers and threads follow the stream.
 * Never display raw transport diagnostics.
 */
export function useSettingsResource<T>(key: string, fetch: (api: SettingsApi) => Promise<T>, enabled = true) {
  const { client } = useSession();

  const shared = useSharedQuery<T>(
    key,
    () => (client ? fetch(client.api) : Promise.reject(new Error("Not paired"))),
    Boolean(client) && enabled,
    SETTINGS_MAX_AGE_MS,
  );

  const error = shared.error ? "Could not load settings. Check the connection and retry." : "";
  const action = useSettingsAction({ reload: shared.reload, error });

  return {
    ...action,
    data: shared.data,
    loading: shared.loading,
    initialLoading: !shared.loaded && !error,
  };
}

/** For actions on workers: the overview stream carries their result. */
export const workersFollowStream = { reload: async () => {}, error: "", loaded: true };

/** Runs settings mutations one at a time; afterwards only the resource behind them reads again. */
export function useSettingsAction(
  resource: { reload: () => Promise<void>; error: string; loaded?: boolean },
  failure = "Could not save this change. Settings were refreshed. Check the values and retry.",
) {
  const { client } = useSession();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const { reload } = resource;

  async function run<R>(action: (api: SettingsApi) => Promise<R>, success = "") {
    if (!client || running.current) return undefined;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const result = await action(client.api);
      await reload().catch(() => undefined);
      setMessage(success);

      return result;
    } catch {
      await reload().catch(() => undefined);
      setError(failure);

      return undefined;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return {
    busy,
    error: error || resource.error,
    message,
    initialLoading: resource.loaded === false && !resource.error,
    reload,
    run,
  };
}

export function ResourceState({
  resource,
  children,
  gap,
}: {
  resource: { initialLoading: boolean; error: string; message: string; reload: () => Promise<void> };
  children: ReactNode;
  gap?: number;
}) {
  const inSheet = useContext(SheetContent);

  return (
    <View
      style={{ gap: gap ?? (inSheet ? 16 : 24) }}
      pointerEvents={resource.initialLoading ? "none" : "auto"}
      accessibilityState={{ busy: resource.initialLoading }}
    >
      {resource.error ? (
        <View style={{ gap: 8 }}>
          <Notice error>{resource.error}</Notice>
          <Button title="Retry" onPress={() => void resource.reload()} />
        </View>
      ) : null}
      {resource.message ? <Notice>{resource.message}</Notice> : null}
      <SkeletonScope loading={resource.initialLoading}>{children}</SkeletonScope>
    </View>
  );
}

export function confirmAction(title: string, description: string, action: () => void) {
  confirm({ title: `${title}?`, description, confirm: title, action });
}
