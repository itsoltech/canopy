import { useEffect, useEffectEvent, useState } from "react";
import type { ui } from "@canopy/contracts";
import { ConnectError, type Client } from "@connectrpc/connect";
import { useSession } from "../../state/session";

/** One independently settling source of # results, scoped by the mounted picker and current query. */
export function useReferenceSearch<T>(
  query: string,
  read: (api: Client<typeof ui.GatewayService>, signal: AbortSignal) => Promise<T>,
  enabled = true,
) {
  const { client } = useSession();
  const [attempt, setAttempt] = useState(0);

  const [found, setFound] = useState<{
    client: typeof client;
    query: string;
    attempt: number;
    data?: T | undefined;
    error?: ConnectError;
  }>();

  const run = useEffectEvent(read);

  useEffect(() => {
    if (!client || !enabled) return;
    const controller = new AbortController();
    const { signal } = controller;

    const timer = setTimeout(
      () => {
        void run(client.api, signal).then(
          (data) => {
            if (!signal.aborted) setFound({ client, query, attempt, data });
          },
          (cause: unknown) => {
            if (signal.aborted) return;
            const error = ConnectError.from(cause);

            setFound((previous) => ({
              client,
              query,
              attempt,
              data: previous?.client === client && previous.query === query ? previous.data : undefined,
              error,
            }));
          },
        );
      },
      query ? 140 : 0,
    );

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, enabled, query, attempt]);

  const current = enabled && found?.query === query && found.client === client ? found : undefined;
  const settled = current?.attempt === attempt;

  return {
    data: current?.data,
    error: settled ? current.error : undefined,
    loading: Boolean(enabled && client && !settled),
    retry: () => setAttempt((previous) => previous + 1),
  };
}
