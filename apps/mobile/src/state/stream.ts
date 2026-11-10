import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { ConnectionRecovery } from "@canopy/domain/connection-recovery";
import { useSession } from "./session";
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

interface StreamStatus {
  key: string;
  connection: Connection;
  retrying: boolean;
  retryAt?: number | undefined;
  issue?: string;
  detail?: string | undefined;
}

/** Backoff and sticky availability are shared with web; only subscriptions retry, never a sent RPC. */
export function useStream<T>(
  watch: ((signal: AbortSignal) => AsyncIterable<T>) | null,
  receive: (value: T) => void | boolean,
  key: string,
) {
  const { active, online, epoch, expired, client } = useSession();
  const { planned } = useGatewayDeparture();
  const start = useEffectEvent((signal: AbortSignal) => watch!(signal));
  const onReceive = useEffectEvent(receive);
  const onExpired = useEffectEvent(expired);
  const recovery = useMemo(() => new ConnectionRecovery(), [key, client]);
  const [state, setState] = useState<StreamStatus>({ key: "", connection: "connecting", retrying: false });
  const [attempt, setAttempt] = useState(0);
  const enabled = Boolean(watch);
  const subscriptionKey = `${key}:${attempt}:${epoch}`;

  useEffect(() => {
    if (!enabled || !active || !online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    recovery.resetBackoff();

    const publish = () => {
      clearTimeout(timer);
      const { status, ...activity } = recovery.snapshot;
      setState((current) => ({
        detail: current.key === subscriptionKey ? current.detail : undefined,
        key: subscriptionKey,
        connection: status,
        ...activity,
        retryAt:
          activity.retryAt === undefined
            ? undefined
            : Math.max(activity.retryAt, client?.diagnostics.snapshot().retryAt ?? 0),
      }));

      if (status === "reconnecting" && recovery.unavailableAt !== undefined)
        timer = setTimeout(
          () => {
            recovery.check();
            publish();
          },
          Math.max(0, recovery.unavailableAt - Date.now()),
        );
    };

    recovery.begin();
    publish();
    void runStream({
      signal: controller.signal,
      recovery,
      start,
      receive: (value) => {
        const live = onReceive(value) !== false;

        if (live) recovery.succeeded();
        publish();

        if (!live && recovery.snapshot.status !== "unavailable")
          setState((current) => ({ ...current, connection: "syncing" }));
      },
      failed: (error) => {
        const { code, rawMessage } = error;

        if (code === Code.Unauthenticated) {
          clearTimeout(timer);
          void onExpired();

          return false;
        }

        if ([Code.NotFound, Code.PermissionDenied, Code.InvalidArgument].includes(code)) {
          clearTimeout(timer);
          setState({
            key: subscriptionKey,
            connection: "error",
            retrying: false,
            issue: "This conversation is no longer available. Return to Threads or retry.",
          });

          return false;
        }

        const detail = /\(([^()]+)\)$/.exec(rawMessage)?.[1];

        if (detail) setState((current) => ({ ...current, detail }));

        return true;
      },
      retryAt: () => client?.diagnostics.snapshot().retryAt ?? 0,
      planned: () => plannedDeparture(client?.departure.snapshot()),
      publish,
    });

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [subscriptionKey, active, online, enabled, client, recovery]);

  const current = state.key === subscriptionKey;

  const connection: Connection = !online
    ? "offline"
    : !active || !enabled
      ? "paused"
      : planned && state.connection === "unavailable"
        ? "reconnecting"
        : current
          ? state.connection
          : recovery.snapshot.status === "unavailable"
            ? "unavailable"
            : "connecting";

  return {
    connection,
    issue: current ? state.issue : undefined,
    detail: current && connection !== "live" ? state.detail : undefined,
    retrying: current && state.retrying,
    retryAt: current ? state.retryAt : undefined,
    retry: () => setAttempt((n) => n + 1),
  };
}

async function runStream<T>(options: {
  signal: AbortSignal;
  recovery: ConnectionRecovery;
  start: (signal: AbortSignal) => AsyncIterable<T>;
  receive: (value: T) => void;
  failed: (error: ConnectError) => boolean;
  retryAt: () => number;
  planned: () => boolean;
  publish: () => void;
}) {
  const { signal, recovery, publish } = options;

  while (!signal.aborted) {
    recovery.begin();
    publish();
    const started = Date.now();

    try {
      for await (const value of options.start(signal)) {
        if (signal.aborted) return;
        options.receive(value);
      }
    } catch (error) {
      if (signal.aborted || !options.failed(ConnectError.from(error))) return;
    }

    if (signal.aborted) return;
    const { retryAt } = recovery.failed();

    const delay = options.planned()
      ? Math.max(0, 2500 - (Date.now() - started))
      : Math.max(retryAt ?? 0, options.retryAt()) - Date.now();

    publish();
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };

      const timer = setTimeout(done, delay);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
