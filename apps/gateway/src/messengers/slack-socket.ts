import { Option, Schema } from "effect";
import { SlackEnvelope, slackEvent, slackEventLogFields, type SlackEvent, type SlackIdentity } from "./slack-events.ts";
import { SlackMessengerError, type SlackTransport, type SlackWebSocket } from "./slack-http.ts";
import type { MessengerIngestOutcome } from "./types.ts";

interface SocketOptions {
  url: string;
  identity: SlackIdentity;
  accountId: string;
  signal: AbortSignal;
  onEvent: (event: SlackEvent) => Promise<readonly MessengerIngestOutcome[] | void>;
  onStatus?: (status: "connecting" | "connected" | "retrying") => Promise<void>;
  log?: (message: string) => void;
  transport?: SlackTransport;
  probe?: boolean;
}

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 2 * MAX_FRAME_BYTES;
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(SlackEnvelope));

async function handleSlackEvent(options: SocketOptions, envelope: typeof SlackEnvelope.Type) {
  const fields = options.log && slackEventLogFields(envelope);
  options.log?.(`stage=received ${fields}`);
  const payload = envelope.payload;

  if (
    payload &&
    ((payload.team_id && payload.team_id !== options.identity.teamId) ||
      (payload.api_app_id && payload.api_app_id !== options.identity.appId))
  ) {
    options.log?.(`stage=rejected reason=event_identity_mismatch ${fields}`);
    throw new SlackMessengerError("configuration", "event_identity_mismatch");
  }

  const event = slackEvent(envelope, options.accountId, options.identity);

  if ("ignored" in event) {
    options.log?.(`stage=ignored reason=${event.ignored} ${fields}`);

    return;
  }

  try {
    const outcomes = await options.onEvent(event);
    options.log?.(`stage=ingest outcome=${outcomes?.join(",") ?? "handled"} ${fields}`);
  } catch {
    options.log?.(`stage=ingest outcome=failed ${fields}`);
    throw new SlackMessengerError("retryable", "socket_ingest_failed");
  }
}

/** Completes on disconnect; caller obtains a fresh one-use URL for every reconnect. */
export function slackSocket(options: SocketOptions): Promise<void> {
  options.signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    let socket: SlackWebSocket;

    try {
      socket = options.transport?.connect?.(options.url) ?? new WebSocket(options.url);
    } catch {
      options.log?.("connection=disconnected reason=socket_connection_failed");
      reject(new SlackMessengerError("retryable", "socket_connection_failed"));

      return;
    }

    let settled = false;
    let hello = false;
    let alive = true;
    let pendingBytes = 0;
    let queue = Promise.resolve();
    const handshake = setTimeout(() => finish(new SlackMessengerError("retryable", "socket_hello_timeout")), 15_000);

    const heartbeat = setInterval(() => {
      if (!alive) return finish(new SlackMessengerError("retryable", "socket_heartbeat_timeout"));
      alive = false;

      if (socket.readyState === WebSocket.OPEN) socket.ping?.();
    }, 30_000);

    const aborted = () => finish(undefined, "aborted");

    function finish(error?: SlackMessengerError, reason = "socket_closed") {
      if (settled) return;
      settled = true;
      options.log?.(`connection=disconnected reason=${error?.code ?? reason}`);
      clearTimeout(handshake);
      clearInterval(heartbeat);
      options.signal.removeEventListener("abort", aborted);
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;

      if (socket.terminate) socket.terminate();
      else socket.close();

      if (error) reject(error);
      else resolve();
    }

    async function receive(data: string) {
      if (settled) return;
      const envelope = Option.getOrUndefined(decodeEnvelope(data));

      if (!envelope) throw new SlackMessengerError("retryable", "invalid_socket_envelope");

      if (envelope.type === "hello") {
        if (envelope.connection_info?.app_id !== options.identity.appId)
          throw new SlackMessengerError("configuration", "app_token_mismatch");
        hello = true;
        clearTimeout(handshake);

        try {
          await options.onStatus?.("connected");
        } catch {
          throw new SlackMessengerError("configuration", "lifecycle_callback_failed");
        }

        if (settled) return;
        options.log?.("connection=connected");

        if (options.probe) finish();

        return;
      }

      if (envelope.type === "disconnect") {
        if (envelope.reason === "link_disabled")
          throw new SlackMessengerError("configuration", "socket_mode_not_enabled");
        finish(
          options.probe ? new SlackMessengerError("retryable", "socket_closed") : undefined,
          "provider_disconnect",
        );

        return;
      }

      if (!hello) throw new SlackMessengerError("retryable", "socket_missing_hello");

      // Store callback commits or detects a duplicate before the corresponding envelope ACK.
      await handleSlackEvent(options, envelope);

      if (!settled && envelope.envelope_id && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        } catch {
          throw new SlackMessengerError("retryable", "socket_ack_failed");
        }
      }
    }

    socket.addEventListener("pong", () => {
      alive = true;
    });
    socket.onmessage = (message) => {
      // Socket Mode specifies UTF-8 JSON text. Binary/oversized frames never enter the ingest queue.
      const data = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(message.data));

      if (data === undefined) return finish(new SlackMessengerError("retryable", "invalid_socket_frame"));
      const bytes = Buffer.byteLength(data);

      if (bytes > MAX_FRAME_BYTES || pendingBytes + bytes > MAX_PENDING_BYTES)
        return finish(new SlackMessengerError("retryable", "socket_frame_limit"));
      alive = true;
      pendingBytes += bytes;
      queue = queue
        .then(() => receive(data))
        .catch((error) => {
          finish(
            error instanceof SlackMessengerError ? error : new SlackMessengerError("retryable", "socket_ingest_failed"),
          );
        })
        .finally(() => {
          pendingBytes -= bytes;
        });
    };

    socket.onclose = () => finish(options.probe ? new SlackMessengerError("retryable", "socket_closed") : undefined);
    socket.onerror = () => finish(new SlackMessengerError("retryable", "socket_connection_failed"));
    options.signal.addEventListener("abort", aborted, { once: true });

    if (options.signal.aborted) aborted();
  });
}
