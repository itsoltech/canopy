import type { ServerHttp2Session } from "node:http2";

/** Network metadata only; never log addresses, certificates, headers or request data. */
export function watchSession(
  session: ServerHttp2Session,
  options: {
    intervalMs: number;
    timeoutMs: number;
    log: (message: string) => void;
  },
) {
  const started = Date.now();
  let reason = "peer_closed";
  let waiting: ReturnType<typeof setTimeout> | undefined;

  const end = (why: string) => {
    reason = why;
    session.destroy();
  };

  options.log("connected tls=established protocol=h2 pin_check=client_side");

  const timer = setInterval(() => {
    if (waiting || session.destroyed) return;
    waiting = setTimeout(() => {
      options.log(`liveness_timeout timeout_ms=${options.timeoutMs}`);
      end("liveness_timeout");
    }, options.timeoutMs);

    try {
      session.ping((error) => {
        clearTimeout(waiting);
        waiting = undefined;

        if (error && !session.destroyed) end("ping_failed");
      });
    } catch {
      end("ping_failed");
    }
  }, options.intervalMs);

  timer.unref();
  session.once("error", () => {
    if (reason === "peer_closed") reason = "session_error";
  });
  session.once("goaway", (code: number, lastStreamId: number) => {
    options.log(`goaway initiator=peer error_code=${code} last_stream_id=${lastStreamId}`);

    if (reason === "peer_closed") reason = "peer_goaway";
  });
  session.once("close", () => {
    clearInterval(timer);
    clearTimeout(waiting);
    options.log(`closed reason=${reason} duration_ms=${Date.now() - started}`);
  });

  return () => {
    reason = "listener_shutdown";
  };
}
