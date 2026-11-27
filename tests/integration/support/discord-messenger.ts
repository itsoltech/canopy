import type { ServerWebSocket } from "bun";
import { Schema } from "effect";
import type { MessengerTransport } from "../../../apps/gateway/src/messengers/provider.ts";

export const discordToken = "fixture_discord_token_first_part.fixture.fixture_discord_token_last_part";
export const discordBot = "100000000000000001";
export const discordChannel = "200000000000000001";
export const discordThread = "200000000000000002";

const Frame = Schema.fromJsonString(
  Schema.Struct({
    op: Schema.Number,
    d: Schema.optional(Schema.Json),
  }),
);

const Resume = Schema.Struct({ session_id: Schema.String, seq: Schema.NullOr(Schema.Number) });
const Body = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

/** Local Discord REST and gateway boundary, including resumable sessions and recorded writes. */
export function discordMessengerFixture(options: { closeOnIdentify?: number } = {}) {
  const sockets = new Set<ServerWebSocket>();
  const dispatched: { s: number; t: string; d: Schema.Json }[] = [];
  const sent: { channel: string; body: Record<string, Schema.Json> }[] = [];
  const resumes: { session_id: string; seq: number | null }[] = [];
  let identifies = 0;
  let nextMessage = 300_000_000_000_000_000n;

  const frame = (socket: ServerWebSocket, value: Schema.Json) => socket.send(JSON.stringify(value));

  const replay = (socket: ServerWebSocket, after: number | null) => {
    for (const event of dispatched)
      if (after === null || event.s > after) frame(socket, { op: 0, s: event.s, t: event.t, d: event.d });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, host) => {
      const path = new URL(request.url).pathname;

      if (path === "/gateway") return host.upgrade(request) ? undefined : new Response(null, { status: 400 });

      if (request.headers.get("authorization") !== `Bot ${discordToken}`) return new Response(null, { status: 401 });

      if (path === "/api/v10/users/@me") return Response.json({ id: discordBot, bot: true });

      if (path === "/api/v10/gateway/bot") return Response.json({ url: "wss://gateway.discord.fixture" });

      if (path === `/api/v10/channels/${discordThread}`)
        return Response.json({ id: discordThread, type: 11, parent_id: discordChannel });

      const messages = /^\/api\/v10\/channels\/(\d+)\/messages$/.exec(path);

      if (messages && request.method === "POST") {
        const channel = messages[1]!;
        sent.push({ channel, body: Schema.decodeSync(Body)(await request.text()) });

        return Response.json({ id: String(++nextMessage), channel_id: channel });
      }

      return new Response(null, { status: 404 });
    },
    websocket: {
      open: (socket) => {
        sockets.add(socket);
        frame(socket, { op: 10, d: { heartbeat_interval: 45_000 } });
      },
      message: (socket, message) => {
        const { op, d } = Schema.decodeSync(Frame)(message.toString());

        if (op === 2) {
          identifies++;

          if (options.closeOnIdentify) return socket.close(options.closeOnIdentify, "fixture");

          const ready = {
            session_id: `session-${identifies}`,
            resume_gateway_url: "wss://resume.discord.fixture",
            user: { id: discordBot, bot: true },
          };

          frame(socket, { op: 0, s: 0, t: "READY", d: ready });
          frame(socket, { op: 0, t: "GUILD_CREATE", d: { channels: [{ id: discordChannel, type: 0 }], threads: [] } });
          replay(socket, null);
        } else if (op === 6) {
          const resume = Schema.decodeUnknownSync(Resume)(d);
          resumes.push(resume);
          replay(socket, resume.seq);
          frame(socket, { op: 0, t: "RESUMED", d: {} });
        } else if (op === 1) frame(socket, { op: 11 });
      },
      close: (socket) => {
        sockets.delete(socket);
      },
    },
  });

  const transport: MessengerTransport = {
    discordApiBaseUrl: `http://127.0.0.1:${server.port}/api/v10/`,
    connect: () => new WebSocket(`ws://127.0.0.1:${server.port}/gateway`),
    reconnectDelayMs: 10,
  };

  return {
    transport,
    sent,
    resumes,
    identifies: () => identifies,
    /** Dispatches a message event with the next sequence number to every open connection. */
    dispatch(t: string, d: Schema.Json) {
      const event = { s: dispatched.length + 1, t, d };
      dispatched.push(event);

      for (const socket of sockets) frame(socket, { op: 0, ...event });

      return event.s;
    },
    close: () => server.stop(true),
  };
}
