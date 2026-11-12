import { useEffect, useEffectEvent, useRef } from "react";
import type { Connection } from "./stream";

/** Counts real opens separately from presentation changes; no pairing or content is logged. */
export function useStreamDiagnostics(
  connection: Connection,
  online: boolean,
  active: boolean,
  epoch: number,
  kind: "thread" | "subscription",
  issue?: string,
) {
  const starts = useRef(0);
  const previous = useRef(connection);
  useEffect(() => {
    if (__DEV__ && previous.current !== connection)
      console.debug("Stream connection changed", {
        at: Date.now(),
        kind,
        from: previous.current,
        to: connection,
        reason: !online ? "network-offline" : !active ? "app-paused" : issue ? "watch-failure" : "watch-progress",
        starts: starts.current,
        epoch,
      });
    previous.current = connection;
  }, [connection, online, active, issue, epoch, kind]);

  return useEffectEvent(() => {
    if (!__DEV__) return;
    starts.current++;

    console.debug("Stream watch started", {
      at: Date.now(),
      kind,
      starts: starts.current,
      epoch,
      reason: starts.current === 1 ? "subscribe" : "resume",
    });
  });
}
