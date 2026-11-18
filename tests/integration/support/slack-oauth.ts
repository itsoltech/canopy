import { createHash } from "node:crypto";
import type { SlackTransport } from "../../../apps/gateway/src/messengers/slack-http.ts";

/** Real local HTTP/Socket Mode fixture; bot code and refresh grants are single-use. */
export function slackOAuthFixture() {
  const codes = new Map<string, string>();
  const refreshTokens = new Set<string>();
  let serial = 0;
  let refreshes = 0;
  let exchanges = 0;
  let teamId = "T12345";
  let appId = "A1";
  let socketAppId = "A1";
  let rejectRefresh = false;
  let holdRefresh: Promise<void> | undefined;
  let refreshStarted: (() => void) | undefined;
  const requests: URLSearchParams[] = [];
  const methods: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, instance) {
      if (new URL(request.url).pathname === "/socket") {
        if (instance.upgrade(request)) return;

        return new Response(null, { status: 400 });
      }

      const method = new URL(request.url).pathname.split("/").at(-1);
      methods.push(method ?? "");
      const body = new URLSearchParams(await request.text());

      if (method === "auth.test") return Response.json({ ok: true, team_id: "T12345", bot_id: "B1", user_id: "UBOT" });

      if (method === "bots.info") return Response.json({ ok: true, bot: { app_id: "A1" } });

      if (method === "apps.connections.open")
        return Response.json({ ok: true, url: "wss://wss-primary.slack.com/fixture" });

      if (method !== "oauth.v2.access") return new Response(null, { status: 404 });
      requests.push(body);

      if (body.get("grant_type") === "refresh_token") {
        refreshes++;
        const valid = refreshTokens.delete(body.get("refresh_token") ?? "");
        refreshStarted?.();
        await holdRefresh;

        if (!valid || rejectRefresh) return Response.json({ ok: false, error: "invalid_refresh_token" });
      } else {
        exchanges++;
        const challenge = codes.get(body.get("code") ?? "");
        codes.delete(body.get("code") ?? "");

        if (
          !challenge ||
          createHash("sha256")
            .update(body.get("code_verifier") ?? "")
            .digest("base64url") !== challenge
        )
          return Response.json({ ok: false, error: "invalid_code" });
      }

      const token = `xoxe-refresh-${++serial}`;
      refreshTokens.add(token);

      return Response.json({
        ok: true,
        access_token: `xoxe.xoxb-fixture-${serial}`,
        refresh_token: token,
        expires_in: 3600,
        token_type: "bot",
        app_id: appId,
        team: { id: teamId },
      });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: "hello", connection_info: { app_id: socketAppId } }));
      },
      message() {},
    },
  });

  const transport: SlackTransport = {
    apiBaseUrl: new URL("api/", server.url).href,
    connect: () => new WebSocket(new URL("socket", server.url).href.replace("http:", "ws:")),
  };

  return {
    transport,
    requests,
    methods,
    get refreshes() {
      return refreshes;
    },
    get exchanges() {
      return exchanges;
    },
    set teamId(value: string) {
      teamId = value;
    },
    set appId(value: string) {
      appId = value;
    },
    set socketAppId(value: string) {
      socketAppId = value;
    },
    set rejectRefresh(value: boolean) {
      rejectRefresh = value;
    },
    set holdRefresh(value: Promise<void> | undefined) {
      holdRefresh = value;
    },
    set refreshStarted(value: (() => void) | undefined) {
      refreshStarted = value;
    },
    consent(url: string) {
      const authorization = new URL(url);
      const code = crypto.randomUUID();
      codes.set(code, authorization.searchParams.get("code_challenge") ?? "");

      return { code, state: authorization.searchParams.get("state")! };
    },
    close: () => server.stop(true),
  };
}
