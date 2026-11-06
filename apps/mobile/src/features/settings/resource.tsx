import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { confirm } from "../../ui/Confirm";
import type { Client } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";
import { Button, Notice, SheetContent } from "../../ui/components";
import { SkeletonScope } from "../../ui/Skeleton";

export type SettingsApi = Client<typeof ui.GatewayService>;

/** Refetch after mutations, including rejected stale revisions. Never display raw transport diagnostics. */
export function useSettingsResource<T>(key: string, fetch: (api: SettingsApi) => Promise<T>) {
  const { client } = useSession();
  const overview = useOverview();
  const fetchRef = useRef(fetch);
  useEffect(() => {
    fetchRef.current = fetch;
  }, [fetch]);
  const generation = useRef(0);
  const running = useRef(false);
  const [result, setResult] = useState<{ key: string; data: T }>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!client) return;
    const id = ++generation.current;

    try {
      const data = await fetchRef.current(client.api);

      if (id === generation.current) {
        setResult({ key, data });
        setError("");
      }
    } catch {
      if (id === generation.current) setError("Could not load settings. Check the connection and retry.");
    } finally {
      if (id === generation.current) setLoading(false);
    }
  }, [client, key]);

  const reload = useCallback(() => {
    setLoading(true);

    return load();
  }, [load]);

  const invalidate = useCallback(() => {
    generation.current++;
  }, []);

  useEffect(() => {
    void load();

    return invalidate;
  }, [load, invalidate]);

  async function run<R>(action: (api: SettingsApi) => Promise<R>, success = "") {
    if (!client || running.current) return undefined;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");

    try {
      const result = await action(client.api);
      await Promise.all([reload(), overview.reload().catch(() => undefined)]);
      setMessage(success);

      return result;
    } catch {
      await reload();
      setError("Could not save this change. Settings were refreshed. Check the values and retry.");

      return undefined;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const data = result?.key === key ? result.data : undefined;

  return { data, loading, initialLoading: data === undefined && !error, busy, error, message, reload, run };
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
