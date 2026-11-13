import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { ConnectionRecovery } from "@canopy/domain/connection-recovery";
import { useSession } from "./session";
import { plannedDeparture } from "../api/departure";
import { useGatewayDeparture } from "./gateway-departure";
import { useStreamDiagnostics } from "./stream-diagnostics";
import { runStream } from "./stream-loop";

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
  receive: (value: T) => void | boolean | null,
  key: string,
  threadFailure?: (error: ConnectError) => { retry: boolean; issue: string; detail?: string },
) {
  const { active, online, epoch, expired, client } = useSession();
  const { planned } = useGatewayDeparture();
  const start = useEffectEvent((signal: AbortSignal) => watch!(signal));
  const onReceive = useEffectEvent(receive);
  const onExpired = useEffectEvent(expired);
  const onThreadFailure = useEffectEvent((error: ConnectError) => threadFailure?.(error));
  const scoped = Boolean(threadFailure);
  const recovery = useMemo(() => new ConnectionRecovery(scoped ? 10_000 : 0), [key, client, scoped]);
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
        issue: current.key === subscriptionKey ? current.issue : undefined,
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
      started: () => diagnosticStart(),
      recovery,
      start,
      receive: (value) => {
        const readiness = onReceive(value);

        if (readiness === null) return;
        const live = readiness !== false;

        if (live) {
          recovery.succeeded();
          setState((current) => ({ ...current, issue: undefined }));
        }

        publish();

        if (!live && recovery.snapshot.status !== "unavailable")
          setState((current) => ({ ...current, connection: "syncing" }));
      },
      failed: (error) =>
        streamFailure(error, {
          expired: onExpired,
          scoped: onThreadFailure,
          update: (change) => setState((current) => ({ ...current, key: subscriptionKey, ...change })),
          stop: () => clearTimeout(timer),
        }),
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

  const diagnosticStart = useStreamDiagnostics(
    connection,
    online,
    active,
    epoch,
    threadFailure ? "thread" : "subscription",
    state.issue,
  );

  return {
    connection,
    issue: current ? state.issue : undefined,
    detail: current && connection !== "live" ? state.detail : undefined,
    retrying: current && state.retrying,
    retryAt: current ? state.retryAt : undefined,
    retry: () => setAttempt((n) => n + 1),
  };
}

function streamFailure(
  error: ConnectError,
  options: {
    expired: () => Promise<void>;
    scoped: (error: ConnectError) => { retry: boolean; issue: string; detail?: string } | undefined;
    update: (change: Partial<StreamStatus>) => void;
    stop: () => void;
  },
) {
  if (error.code === Code.Unauthenticated) {
    options.stop();
    void options.expired();

    return false;
  }

  const scoped = options.scoped(error);

  if (scoped) {
    if (!scoped.retry) options.stop();
    options.update({
      issue: scoped.issue,
      detail: scoped.detail,
      connection: scoped.retry ? "reconnecting" : "error",
      retrying: false,
    });

    return scoped.retry;
  }

  if ([Code.NotFound, Code.PermissionDenied, Code.InvalidArgument].includes(error.code)) {
    options.stop();
    options.update({
      connection: "error",
      retrying: false,
      issue: "This conversation is no longer available. Return to Threads or retry.",
    });

    return false;
  }

  const detail = /\(([^()]+)\)$/.exec(error.rawMessage)?.[1];

  if (detail) options.update({ detail });

  return true;
}
