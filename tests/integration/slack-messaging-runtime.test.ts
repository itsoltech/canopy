import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, connectors, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import { MessengerStore } from "../../apps/gateway/src/messengers/store.ts";
import type { SlackBotAuthorization } from "../../apps/gateway/src/messengers/types.ts";
import type { SlackTransport, SlackWebSocket } from "../../apps/gateway/src/messengers/slack-http.ts";
import { encryptSecret } from "../../apps/gateway/src/store/secrets.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { slackMessengerFixture } from "./support/slack-messenger.ts";

const clientId = "runtime-slack-client";
const rotatedToken = "xoxe.xoxb-after-refresh";

const original: SlackBotAuthorization = {
  appToken: "xapp-runtime-fixture",
  botToken: "xoxe.xoxb-before-refresh",
  refreshToken: "fixture-refresh-before",
  clientId,
  appId: "AAPP",
  teamId: "TWORK",
  expiresAt: Date.now() + 3_600_000,
};

function rotatingSlack(onRefresh: () => void) {
  const slack = slackMessengerFixture();
  const connect = slack.transport.connect;
  const apiBaseUrl = slack.transport.apiBaseUrl;

  if (!connect || !apiBaseUrl) throw new Error("Local socket fixture transport is required");
  const sockets: SlackWebSocket[] = [];
  const requests: { method: string; authorization: string | null }[] = [];
  const refreshes: URLSearchParams[] = [];

  const transport: SlackTransport = {
    ...slack.transport,
    connect: (url) => {
      const socket = connect(url);
      sockets.push(socket);

      return socket;
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(url.origin).toBe(new URL(apiBaseUrl).origin);
      const method = url.pathname.slice("/api/".length);
      requests.push({ method, authorization: request.headers.get("authorization") });

      if (method === "oauth.v2.access") {
        refreshes.push(new URLSearchParams(await request.text()));
        onRefresh();

        return Response.json({
          ok: true,
          access_token: rotatedToken,
          refresh_token: "fixture-refresh-after",
          expires_in: 3600,
          token_type: "bot",
          app_id: "AAPP",
          team: { id: "TWORK" },
        });
      }

      return fetch(request);
    },
  };

  return { ...slack, transport, sockets, requests, refreshes };
}

const messenger = <A, E>(gw: TestGateway, use: (store: MessengerStore["Service"]) => Effect.Effect<A, E>) =>
  gw.runtime.runPromise(MessengerStore.use(use));

const query = <A extends object>(gw: TestGateway, statement: string, values: readonly string[] = []) =>
  gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(statement, values)));

async function saveCredentials(gw: TestGateway, accountId: string, value: SlackBotAuthorization) {
  await gw.runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`UPDATE messenger_accounts SET credentials=${encryptSecret(gw.secretsKey, JSON.stringify(value))},
        external_id='TWORK:BAPP',connector_team_id='TWORK',status='connected' WHERE id=${accountId}::uuid`,
    ),
  );
}

async function seedMessaging(gw: TestGateway) {
  await gw.core.connectors.saveApp(
    create(connectors.SaveConnectorOAuthAppRequestSchema, {
      connectorType: "slack",
      issuer: "https://slack.example.test",
      clientId,
      clientSecret: "fixture-client-secret",
    }),
  );

  const connector = await gw.core.connectors.save(
    create(connectors.SaveConnectorAccountRequestSchema, {
      connectorType: "slack",
      name: "Runtime Slack",
      authKind: "oauth",
    }),
  );

  await gw.core.connectors.run((store) =>
    Effect.gen(function* () {
      const row = yield* store.owned(gw.userId, connector.id);
      yield* store.updateCredentials(
        row,
        { slackTeamId: "TWORK", tokens: { access_token: "fixture-mcp-user-token", token_type: "bearer" } },
        "connected",
      );
    }),
  );

  const account = await messenger(gw, (store) =>
    store.saveAccount(gw.userId, {
      connectorAccountId: connector.id,
      name: "Runtime Slack",
      externalId: "TWORK:BAPP",
      appToken: original.appToken,
    }),
  );

  await saveCredentials(gw, account.id, original);

  const bot = await gw.core.bots.create(
    create(bots.CreateBotRequestSchema, {
      clientRequestId: Bun.randomUUIDv7(),
      configuration: {
        name: "Rotation bot",
        provider: Provider.CODEX,
        providerInstance: "native",
        model: "gpt-6.1-sol",
        shape: "round",
        color: "#22aaff",
      },
    }),
  );

  const route = await messenger(gw, (store) =>
    store.saveRoute(gw.userId, {
      botId: bot.id,
      accountId: account.id,
      channelIds: ["CGENERAL"],
      userIds: ["UOWNER"],
      directMessages: false,
      mentions: true,
      observe: false,
      delivery: "reply",
      instructions: "Reply after token rotation.",
    }),
  );

  return { connector, account, bot, route };
}

test.skipIf(!dockerAvailable)(
  "linked Slack bot token rotation replaces a live session and sends with refreshed credentials",
  async () => {
    let clockOffset = 0;

    const slack = rotatingSlack(() => {
      clockOffset += 45_000;
    });

    let gw: TestGateway | undefined;

    try {
      const gateway = await startTestGateway({
        messengerTransport: slack.transport,
        botClock: () => new Date(Date.now() + clockOffset),
      });

      gw = gateway;
      await gateway.core.bots.stop();
      const f = await seedMessaging(gateway);
      gateway.core.messengers.start();
      const connected = () => messenger(gateway, (store) => store.accounts(gateway.userId));
      expect(
        (
          await eventually(
            connected,
            (rows) =>
              rows[0]?.status === "connected" &&
              slack.sockets.length >= 2 &&
              slack.sockets.some((socket) => socket.readyState === WebSocket.OPEN),
          )
        )[0]?.status,
      ).toBe("connected");
      const liveSocket = slack.sockets.find((socket) => socket.readyState === WebSocket.OPEN);
      expect(liveSocket).toBeDefined();

      const before = (
        await query<{ lease_token: string }>(gateway, "SELECT lease_token FROM messenger_accounts WHERE id=$1", [
          f.account.id,
        ])
      )[0]!;

      expect(slack.refreshes).toHaveLength(0);
      expect(
        new Set(
          slack.requests.filter((request) => request.method === "auth.test").map((request) => request.authorization),
        ),
      ).toEqual(new Set([`Bearer ${original.botToken}`]));

      await saveCredentials(gateway, f.account.id, { ...original, expiresAt: Date.now() - 1 });
      gateway.core.messengers.wake();

      const after = await eventually(
        () =>
          query<{ lease_token: string; status: string; current_lease: boolean }>(
            gateway,
            "SELECT lease_token,status,lease_until>$2::timestamptz AS current_lease FROM messenger_accounts WHERE id=$1",
            [f.account.id, new Date(Date.now() + clockOffset).toISOString()],
          ),
        (rows) =>
          rows[0]?.status === "connected" && rows[0].lease_token !== before.lease_token && rows[0].current_lease,
      );

      expect(after[0]).toMatchObject({ status: "connected", current_lease: true });
      expect(after[0]?.lease_token).not.toBe(before.lease_token);
      expect(liveSocket?.readyState).toBe(WebSocket.CLOSED);
      expect(slack.sockets.filter((socket) => socket.readyState === WebSocket.OPEN)).toHaveLength(1);
      expect(slack.refreshes).toHaveLength(1);
      expect(Object.fromEntries(slack.refreshes[0]!)).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: original.refreshToken,
        client_id: clientId,
        client_secret: "fixture-client-secret",
      });

      for (const method of ["auth.test", "bots.info"])
        expect(slack.requests.filter((request) => request.method === method).at(-1)?.authorization).toBe(
          `Bearer ${rotatedToken}`,
        );

      slack.emit("after-refresh", "<@UAPP> reply using the refreshed session", "100.1");
      expect(await eventually(async () => slack.acknowledged.has("after-refresh"), Boolean)).toBe(true);
      clockOffset += 4000;
      gateway.core.messengers.wake();
      expect(
        await eventually(
          async () =>
            (await query(gateway, "SELECT id FROM bot_turns WHERE bot_id=$1 AND status='queued'", [f.bot.id])).length,
          (count) => count === 1,
        ),
      ).toBe(1);
      const turn = await gateway.runtime.runPromise(BotStore.use((store) => store.claim(gateway.userId)));
      expect(turn?.input).toContain("reply using the refreshed session");

      if (!turn) throw new Error("Expected a queued external turn");
      await gateway.runtime.runPromise(BotStore.use((store) => store.finish(turn, "completed", "Rotation succeeded")));
      expect(
        await eventually(
          async () => slack.sent.length,
          (count) => count === 1,
        ),
      ).toBe(1);
      expect(slack.requests.find((request) => request.method === "chat.postMessage")?.authorization).toBe(
        `Bearer ${rotatedToken}`,
      );
      expect(slack.sent[0]?.get("text")).toBe("Rotation succeeded");
      expect(
        await eventually(
          () => query<{ status: string }>(gateway, "SELECT status FROM messenger_outbound WHERE turn_id=$1", [turn.id]),
          (rows) => rows[0]?.status === "sent",
        ),
      ).toEqual([{ status: "sent" }]);
      expect(await messenger(gateway, (store) => store.routes(gateway.userId, f.bot.id))).toEqual([f.route]);
      expect((await connected())[0]).toMatchObject({
        id: f.account.id,
        externalId: "TWORK:BAPP",
        connectorAccountId: f.connector.id,
        enabled: true,
        status: "connected",
      });

      const credentials = await messenger(gateway, (store) => store.savedCredentials(gateway.userId, f.account.id));

      expect(credentials).toMatchObject({
        botToken: rotatedToken,
        refreshToken: "fixture-refresh-after",
        appToken: original.appToken,
      });
      expect(credentials.expiresAt).toBeGreaterThan(Date.now() + 60_000);
      expect(slack.refreshes).toHaveLength(1);
    } finally {
      await gw?.close();
      await slack.close();
    }
  },
);
