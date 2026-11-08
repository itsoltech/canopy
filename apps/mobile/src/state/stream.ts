import { useEffect, useEffectEvent, useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { useSession } from "./session";
import { useRouteStatus } from "./route-status";
import { hasTailscaleFailure } from "../api/tailscale-hint";
import { plannedDeparture } from "../api/departure";
import { useGatewayDeparture } from "./gateway-departure";

export type Connection =
  | "connecting"
  | "syncing"
  | "live"
  | "reconnecting"
  | "unavailable"
  | "offline"
  | "paused"
  | "error";

/** How long a stream stays down before the gateway counts as unavailable (web: live-source.ts). */
const UNAVAILABLE_AFTER = 12_000;

/** Backoff with jitter, fresh snapshots, cancellation, and foreground/network resubscription. */
export function useStream<T>(
  watch: ((signal: AbortSignal) => AsyncIterable<T>) | null,
  receive: (value: T) => void | boolean,
  key: string,
) {
  const { active, online, epoch, expired, client } = useSession();
  const { planned } = useGatewayDeparture();
  const routes = useRouteStatus();
  const tailscale = hasTailscaleFailure(routes);
  const start = useEffectEvent((signal: AbortSignal) => watch!(signal));
  const onReceive = useEffectEvent(receive);
  const onExpired = useEffectEvent(expired);

  const [state, setState] = useState<{ key: string; connection: Connection; issue?: string; detail?: string }>({
    key: "",
    connection: "connecting",
  });

  const [attempt, setAttempt] = useState(0);
  const [stale, setStale] = useState("");
  const enabled = Boolean(watch);
  const subscriptionKey = `${key}:${attempt}:${epoch}`;
  useEffect(() => {
    if (!enabled || !active || !online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function run() {
      let failures = 0;
      // A stream resubscribing after the background or a network change is not live until it answers again.
      setState((current) =>
        current.key === subscriptionKey ? { key: subscriptionKey, connection: "connecting" } : current,
      );

      while (!controller.signal.aborted) {
        const started = Date.now();
        let reason: string | undefined;

        try {
          for await (const value of start(controller.signal)) {
            if (controller.signal.aborted) return;
            const live = onReceive(value) !== false;
            setState({ key: subscriptionKey, connection: live ? "live" : "syncing" });
            failures = 0;
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
        setState({ key: subscriptionKey, connection: "reconnecting", ...(reason && { detail: reason.slice(1, -1) }) });

        // Read the completed race now, before React renders it. Only subscriptions retry; never replay an RPC.
        const delay = plannedDeparture(client?.departure.snapshot())
          ? Math.max(0, 2500 - (Date.now() - started))
          : client && hasTailscaleFailure(client.diagnostics.snapshot())
            ? 5000
            : Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) * (0.8 + Math.random() * 0.4);

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
  }, [subscriptionKey, active, online, epoch, enabled, client]);

  // A stream that stays down or keeps connecting past the threshold means the gateway does not answer.
  const down =
    enabled &&
    active &&
    online &&
    (state.key !== subscriptionKey || state.connection === "reconnecting" || state.connection === "connecting");

  useEffect(() => {
    if (!down) return;
    const timer = setTimeout(() => setStale(subscriptionKey), UNAVAILABLE_AFTER);

    return () => {
      clearTimeout(timer);
      setStale("");
    };
  }, [down, subscriptionKey]);

  const connection: Connection = !online
    ? "offline"
    : !active || !enabled
      ? "paused"
      : down && stale === subscriptionKey && (!routes.pending || tailscale) && !planned
        ? "unavailable"
        : state.key !== subscriptionKey
          ? "connecting"
          : state.connection;

  return {
    connection,
    issue: state.key === subscriptionKey ? state.issue : undefined,
    /** The native transport code of the last failure (`timeout`, `POSIX 50`, `NSURLErrorDomain -1200`). */
    detail: state.key === subscriptionKey ? state.detail : undefined,
    retry: () => setAttempt((n) => n + 1),
  };
}
