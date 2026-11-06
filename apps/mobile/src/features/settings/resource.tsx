import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, View } from "react-native";
import type { Client } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";

export type SettingsApi = Client<typeof ui.GatewayService>;

/** Refetch after mutations, including rejected stale revisions. Never display raw transport diagnostics. */
export function useSettingsResource<T>(key: string, fetch: (api: SettingsApi) => Promise<T>) {
  const { client } = useSession();
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
      await reload();
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

  return { data: result?.key === key ? result.data : undefined, loading, busy, error, message, reload, run };
}

export function ResourceState({
  resource,
  children,
}: {
  resource: { loading: boolean; error: string; message: string; reload: () => Promise<void> };
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 24 }}>
      {resource.loading && <Notice>Loading settings…</Notice>}
      {resource.error ? (
        <View style={{ gap: 8 }}>
          <Notice error>{resource.error}</Notice>
          <Button secondary title="Retry" onPress={() => void resource.reload()} />
        </View>
      ) : null}
      {resource.message ? <Notice>{resource.message}</Notice> : null}
      {children}
    </View>
  );
}

export function confirmAction(title: string, description: string, action: () => void) {
  Alert.alert(`${title}?`, description, [
    { text: "Cancel", style: "cancel" },
    { text: title, style: "destructive", onPress: action },
  ]);
}
