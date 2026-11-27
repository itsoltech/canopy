import { Option, Schema } from "effect";
import {
  DiscordChannel,
  DiscordUser,
  GuildCreate,
  discordEvent,
  type DiscordChannels,
  type DiscordDispatch,
} from "./discord-events.ts";
import { discordError, discordRequest } from "./discord-http.ts";
import { MessengerError } from "./messenger-error.ts";
import type { MessengerRunOptions } from "./provider.ts";
import type { SlackWebSocket } from "./slack-http.ts";

/** Guilds, guild messages, direct messages and message content. */
const intents = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const Frame = Schema.fromJsonString(
  Schema.Struct({
    op: Schema.Number,
    d: Schema.optional(Schema.Json),
    s: Schema.optional(Schema.NullOr(Schema.Number)),
    t: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

const Hello = Schema.Struct({ heartbeat_interval: Schema.Number });

const Ready = Schema.Struct({
  session_id: Schema.String,
  resume_gateway_url: Schema.String.check(Schema.isPattern(/^wss:\/\/[^\s/]+$/)),
  user: DiscordUser,
});

/** Resume state survives reconnects so Discord replays events missed while disconnected. */
export interface DiscordSession {
  id: string;
  url: string;
  seq: number | null;
}

/** Per-account connection state that outlives one socket. */
export interface DiscordState {
  session?: DiscordSession | undefined;
}

export interface DiscordGatewayOptions extends MessengerRunOptions {
  url: string;
  channels: DiscordChannels;
  state: DiscordState;
  signal: AbortSignal;
  probe?: boolean;
}

const configurationCloses = new Map([
  [4004, "unauthorized"],
  [4010, "invalid_shard"],
  [4011, "sharding_required"],
  [4012, "invalid_api_version"],
  [4013, "invalid_intents"],
  [4014, "message_content_intent"],
]);

const decoder =
  <A>(decode: (value: Schema.Json | undefined) => Option.Option<A>) =>
  (value: Schema.Json | undefined) =>
    Option.getOrUndefined(decode(value));

const decodeChannel = decoder(Schema.decodeUnknownOption(DiscordChannel));
const decodeGuild = decoder(Schema.decodeUnknownOption(GuildCreate));
const decodeHello = decoder(Schema.decodeUnknownOption(Hello));
const decodeReady = decoder(Schema.decodeUnknownOption(Ready));

const decodeLocation = decoder(
  Schema.decodeUnknownOption(Schema.Struct({ channel_id: Schema.String, guild_id: Schema.optional(Schema.String) })),
);

function closeError(code: number, state: DiscordGatewayOptions["state"]) {
  const configuration = configurationCloses.get(code);

  if (configuration) return discordError("configuration", configuration);

  // An invalid sequence or expired session cannot be resumed.
  if (code === 4007 || code === 4009) state.session = undefined;

  return discordError("retryable", `gateway_closed_${code}`);
}

async function resolveChannel(options: DiscordGatewayOptions, id: string) {
  if (options.channels.known(id)) return;

  try {
    const channel = decodeChannel(
      await discordRequest(`channels/${id}`, options.credentials.botToken, options.signal, options.transport),
    );

    if (channel) options.channels.record(channel);
  } catch (error) {
    if (error instanceof MessengerError && error.kind === "retryable") throw error;
  }

  if (!options.channels.known(id)) options.channels.record({ id, type: 0 });
}

async function dispatch(options: DiscordGatewayOptions, type: string, data: Schema.Json | undefined) {
  if (type === "GUILD_CREATE") {
    const guild = decodeGuild(data);

    for (const channel of [...(guild?.channels ?? []), ...(guild?.threads ?? [])]) options.channels.record(channel);

    return;
  }

  if (["THREAD_CREATE", "THREAD_UPDATE", "CHANNEL_CREATE", "CHANNEL_UPDATE"].includes(type)) {
    const channel = decodeChannel(data);

    if (channel) options.channels.record(channel);

    return;
  }

  if (type !== "MESSAGE_CREATE" && type !== "MESSAGE_UPDATE" && type !== "MESSAGE_DELETE") return;
  const located = decodeLocation(data);

  if (located?.guild_id) await resolveChannel(options, located.channel_id);
  const kind: DiscordDispatch = type;
  const event = discordEvent(kind, data ?? null, options.accountId, options.botUserId, options.channels);

  if ("ignored" in event) {
    options.log?.(`stage=ignored reason=${event.ignored}`);

    return;
  }

  try {
    const outcomes = await options.onEvent(event);
    options.log?.(`stage=ingest outcome=${outcomes?.join(",") ?? "handled"}`);
  } catch {
    throw discordError("retryable", "ingest_failed");
  }
}

/** One gateway connection. Completes or rejects on disconnect; the session is kept for a resume. */
export function discordGateway(options: DiscordGatewayOptions): Promise<void> {
  options.signal.throwIfAborted();
  const { state } = options;
  const url = `${state.session?.url ?? options.url}/?v=10&encoding=json`;

  return new Promise((resolve, reject) => {
    let socket: SlackWebSocket;

    try {
      socket = options.transport?.connect?.(url) ?? new WebSocket(url);
    } catch {
      reject(discordError("retryable", "socket_connection_failed"));

      return;
    }

    let settled = false;
    let acknowledged = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let queue = Promise.resolve();
    // Last sequence the gateway durably handled; heartbeats and resumes never claim more.
    let handled = state.session?.seq ?? null;
    const handshake = setTimeout(() => finish(discordError("retryable", "gateway_hello_timeout")), 20_000);
    const aborted = () => finish();

    function finish(error?: MessengerError) {
      if (settled) return;
      settled = true;
      clearTimeout(handshake);
      clearInterval(heartbeat);
      options.signal.removeEventListener("abort", aborted);
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close(error?.kind === "configuration" ? 1000 : 4000);
      options.log?.(`connection=disconnected reason=${error?.code ?? "closed"}`);

      if (error) reject(error);
      else resolve();
    }

    const send = (op: number, d: Schema.Json) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op, d }));
    };

    const beat = () => {
      if (!acknowledged) return finish(discordError("retryable", "gateway_heartbeat_timeout"));
      acknowledged = false;
      send(1, handled);
    };

    async function connected() {
      clearTimeout(handshake);
      await options.onStatus?.("connected");
      options.log?.("connection=connected");

      if (options.probe) finish();
    }

    async function receive(frame: typeof Frame.Type) {
      if (frame.op === 10) {
        const hello = decodeHello(frame.d);

        if (!hello) throw discordError("retryable", "invalid_hello");
        heartbeat = setInterval(beat, hello.heartbeat_interval);
        const token = options.credentials.botToken;

        if (state.session) send(6, { token, session_id: state.session.id, seq: state.session.seq });
        else send(2, { token, intents, properties: { os: "linux", browser: "canopy", device: "canopy" } });

        return;
      }

      if (frame.op === 11) acknowledged = true;
      else if (frame.op === 1) send(1, handled);
      else if (frame.op === 7) throw discordError("retryable", "reconnect_requested");
      else if (frame.op === 9) {
        if (frame.d !== true) state.session = undefined;

        throw discordError("retryable", "invalid_session", 2000);
      } else if (frame.op === 0 && frame.t) await event(frame.t, frame.d, frame.s ?? null);
    }

    async function event(type: string, data: Schema.Json | undefined, seq: number | null) {
      if (type === "READY") {
        const ready = decodeReady(data);

        if (!ready) throw discordError("retryable", "invalid_ready");

        if (ready.user.id !== options.botUserId) throw discordError("configuration", "bot_identity_mismatch");
        state.session = { id: ready.session_id, url: ready.resume_gateway_url, seq };
        await connected();
      } else if (type === "RESUMED") await connected();
      else await dispatch(options, type, data);

      if (seq !== null) {
        handled = seq;

        if (state.session) state.session.seq = seq;
      }
    }

    socket.onmessage = (message) => {
      const text = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(message.data));

      if (text === undefined || Buffer.byteLength(text) > MAX_FRAME_BYTES)
        return finish(discordError("retryable", "invalid_gateway_frame"));
      const frame = Option.getOrUndefined(Schema.decodeUnknownOption(Frame)(text));

      if (!frame) return finish(discordError("retryable", "invalid_gateway_frame"));
      queue = queue
        .then(() => (settled ? undefined : receive(frame)))
        .catch((error: Error) => {
          finish(error instanceof MessengerError ? error : discordError("retryable", "gateway_failed"));
        });
    };

    socket.onclose = (close) => finish(closeError(close.code, state));
    socket.onerror = () => finish(discordError("retryable", "socket_connection_failed"));
    options.signal.addEventListener("abort", aborted, { once: true });

    if (options.signal.aborted) aborted();
  });
}
