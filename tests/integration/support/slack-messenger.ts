import type { JsonObject } from "@canopy/domain";
import type { ServerWebSocket } from "bun";
import { Schema } from "effect";
import type { SlackTransport } from "../../../apps/gateway/src/messengers/slack.ts";

/** Local Slack HTTP + Socket Mode boundary; no external network or model calls. */
export function slackMessengerFixture(channelType: "channel" | "group" = "channel") {
  const sockets = new Set<ServerWebSocket>();
  const acknowledged = new Set<string>();
  const sent: URLSearchParams[] = [];
  let refusal: string | undefined;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, host) => {
      const path = new URL(request.url).pathname;

      if (path === "/socket") {
        if (host.upgrade(request)) return;

        return new Response(null, { status: 400 });
      }

      if (path === "/api/auth.test")
        return Response.json({ ok: true, bot_id: "BAPP", team_id: "TWORK", user_id: "UAPP" });

      if (path === "/api/bots.info") return Response.json({ ok: true, bot: { app_id: "AAPP" } });

      if (path === "/api/apps.connections.open")
        return Response.json({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=fixture" });

      if (path === "/api/chat.postMessage") {
        const fields = new URLSearchParams(await request.text());
        sent.push(fields);

        if (refusal) {
          const error = refusal;
          refusal = undefined;

          return Response.json({ ok: false, error });
        }

        return Response.json({ ok: true, channel: fields.get("channel"), ts: `200.${sent.length}` });
      }

      return new Response(null, { status: 404 });
    },
    websocket: {
      open: (socket) => {
        sockets.add(socket);
        socket.send(JSON.stringify({ type: "hello", connection_info: { app_id: "AAPP" } }));
      },
      message: (_socket, message) => {
        const ack = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ envelope_id: Schema.String })))(
          message.toString(),
        );

        acknowledged.add(ack.envelope_id);
      },
      close: (socket) => {
        sockets.delete(socket);
      },
    },
  });

  const transport: SlackTransport = {
    apiBaseUrl: new URL("api/", server.url).href,
    connect: () => new WebSocket(`ws://127.0.0.1:${server.port}/socket`),
    reconnectDelayMs: 10,
  };

  const emitEvent = (id: string, event: JsonObject) => {
    const message = JSON.stringify({
      type: "events_api",
      envelope_id: id,
      payload: {
        type: "event_callback",
        event_id: id,
        team_id: "TWORK",
        api_app_id: "AAPP",
        event: { type: "message", channel: "CGENERAL", user: "UOWNER", channel_type: channelType, ...event },
      },
    });

    for (const socket of sockets) socket.send(message);
  };

  return {
    transport,
    acknowledged,
    connected: () => sockets.size,
    sent,
    refuseNextSend: (code: string) => {
      refusal = code;
    },
    emitEvent,
    emit: (
      id: string,
      text: string,
      timestamp: string,
      threadId: string | null = "100.1",
      files?: readonly { id: string; url_private?: string }[],
      eventType: "message" | "app_mention" = "message",
    ) =>
      emitEvent(id, {
        type: eventType,
        text,
        ts: timestamp,
        ...(threadId && { thread_ts: threadId }),
        ...(files && { files: [...files] }),
      }),
    close: () => server.stop(true),
  };
}
