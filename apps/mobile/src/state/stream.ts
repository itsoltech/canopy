import { useEffect, useEffectEvent, useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { useSession } from "./session";

export type Connection = "connecting" | "live" | "reconnecting" | "offline" | "paused" | "error";

/** Backoff with jitter, fresh snapshots, cancellation, and foreground/network resubscription. */
export function useStream<T>(
  watch: ((signal: AbortSignal) => AsyncIterable<T>) | null,
  receive: (value: T) => void,
  key: string,
) {
  const { active, online, expired } = useSession();
  const start = useEffectEvent((signal: AbortSignal) => watch!(signal));
  const onReceive = useEffectEvent(receive);
  const onExpired = useEffectEvent(expired);

  const [state, setState] = useState<{ key: string; connection: Connection; issue?: string }>({
    key: "",
    connection: "connecting",
  });

  const [attempt, setAttempt] = useState(0);
  const enabled = Boolean(watch);
  const subscriptionKey = `${key}:${attempt}`;
  useEffect(() => {
    if (!enabled || !active || !online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function run() {
      let failures = 0;

      while (!controller.signal.aborted) {
        let reason: string | undefined;

        try {
          for await (const value of start(controller.signal)) {
            if (controller.signal.aborted) return;
            setState({ key: subscriptionKey, connection: "live" });
            failures = 0;
            onReceive(value);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          const { code, rawMessage } = ConnectError.from(error);
          // The transport ends its messages with the native code, e.g. "(NSURLErrorDomain -1200)".
          reason = /\(([^()]+)\)$/.exec(rawMessage)?.[0];

          if (code === Code.Unauthenticated) {
            await onExpired();

            return;
          }

          if ([Code.NotFound, Code.PermissionDenied, Code.InvalidArgument].includes(code)) {
            setState({
              key: subscriptionKey,
              connection: "error",
              issue: "This conversation is no longer available. Return to Threads or retry.",
            });

            return;
          }
        }

        if (controller.signal.aborted) return;
        setState({
          key: subscriptionKey,
          connection: "reconnecting",
          ...(reason && { issue: `Connection lost. Reconnecting automatically… ${reason}` }),
        });
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) * (0.8 + Math.random() * 0.4);
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", done);
            resolve();
          };

          timer = setTimeout(done, delay);
          controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    }

    void run();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [subscriptionKey, active, online, enabled]);

  const connection: Connection = !online
    ? "offline"
    : !active || !enabled
      ? "paused"
      : state.key !== subscriptionKey
        ? "connecting"
        : state.connection;

  return {
    connection,
    issue: state.key === subscriptionKey ? state.issue : undefined,
    retry: () => setAttempt((n) => n + 1),
  };
}
