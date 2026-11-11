import type { Http2Session } from "node:http2";
import { constants } from "node:http2";
import { ConnectError } from "@connectrpc/connect";
import { Http2SessionManager } from "@connectrpc/connect-node";

/** Only stable codes cross the log boundary; error messages and GOAWAY debug data can contain private data. */
export function linkFailure(cause: unknown) {
  const error = ConnectError.from(cause);

  const reasons = new Map([
    ["Invalid computer identity", "invalid_identity"],
    ["Invalid computer certificate", "invalid_certificate"],
    ["Invalid relay computer", "invalid_relay_computer"],
    ["Invalid relay catalog", "invalid_relay_catalog"],
    ["Handshake required", "handshake_required"],
    ["Unsupported link message", "unsupported_message"],
    ["Computer link fell behind", "output_overflow"],
    ["Computer link heartbeat timed out", "heartbeat_timeout"],
    ["Computer link handshake timed out", "handshake_timeout"],
    ["PING timed out", "ping_timeout"],
  ]);

  const systemCode = [
    "ERR_HTTP2_SESSION_ERROR",
    "ERR_HTTP2_STREAM_ERROR",
    "ERR_HTTP2_GOAWAY_SESSION",
    "ERR_HTTP2_OUT_OF_MEMORY",
    "ERR_HTTP2_INVALID_SESSION",
    "ERR_HTTP2_PING_CANCEL",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
  ].find((code) => cause instanceof Error && "code" in cause && cause.code === code);

  return { code: error.code, reason: reasons.get(error.rawMessage) ?? "rpc_error", systemCode };
}

/** Observe the public stream/session API, without sharing the probe's socket or logging its authority. */
export class LinkSessionManager extends Http2SessionManager {
  readonly #observed = new WeakSet<Http2Session>();
  #localAbort = false;

  override async request(...args: Parameters<Http2SessionManager["request"]>) {
    const stream = await super.request(...args);
    const session = stream.session;

    if (session && !this.#observed.has(session)) {
      this.#observed.add(session);
      const started = Date.now();
      let initiator = "unknown";
      let goawayCode: number | undefined;

      session.on("goaway", (code: number, lastStreamId: number) => {
        initiator = "peer";
        goawayCode = code;
        console.debug("Computer link HTTP/2 GOAWAY", { initiator, goawayCode, lastStreamId });
      });
      session.once("error", (error: Error) => {
        const errno = "errno" in error ? Number(error.errno) : undefined;
        const log = this.#localAbort ? console.debug : console.warn;
        log("Computer link HTTP/2 error", {
          ...linkFailure(error),
          initiator: initiator === "peer" ? "peer" : this.#localAbort ? "local" : initiator,
          goawayCode:
            goawayCode ?? (this.#localAbort ? constants.NGHTTP2_CANCEL : Number.isInteger(errno) ? errno : undefined),
        });
      });
      session.once("close", () => {
        console.debug("Computer link HTTP/2 closed", {
          initiator: initiator === "peer" ? "peer" : this.#localAbort ? "local" : initiator,
          goawayCode: goawayCode ?? (this.#localAbort ? constants.NGHTTP2_CANCEL : undefined),
          durationMs: Date.now() - started,
        });
      });
    }

    return stream;
  }

  override abort(reason?: Error) {
    if (!["closed", "error"].includes(this.state())) {
      this.#localAbort = true;
      console.debug("Computer link HTTP/2 abort", {
        initiator: "local",
        goawayCode: constants.NGHTTP2_CANCEL,
        ...(reason ? linkFailure(reason) : { reason: "runtime_close" }),
      });
    }

    super.abort(reason);
  }
}
