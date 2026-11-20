import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore } from "@canopy/gateway/store";
import { MessengerStore } from "../../apps/gateway/src/messengers/store.ts";
import { oauthRedirectUrl } from "../../apps/gateway/src/connectors/catalog.ts";
import { slackUserCredentials } from "../../apps/gateway/src/connectors/slack-user-refresh.ts";
import { digest } from "../../apps/gateway/src/connectors/records.ts";
import { fakeConnector } from "./support/connector.ts";
import { slackOAuthFixture } from "./support/slack-oauth.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

const binding = "u".repeat(43);
const redirectUri = "http://127.0.0.1:19123/api/connectors/oauth/callback";

describe.skipIf(!dockerAvailable)("durable Slack MCP user refresh", () => {
  let gw: TestGateway;
  let mcp: ReturnType<typeof fakeConnector>;
  let slack: ReturnType<typeof slackOAuthFixture>;
  let hold: Promise<void> | undefined;
  let started: (() => void) | undefined;
  let slackUser = "U12345";

  const connector = <A, E>(use: (store: GatewayStore["Service"]["connectors"]) => Effect.Effect<A, E>) =>
    gw.runtime.runPromise(GatewayStore.use((s) => use(s.connectors)));

  const messenger = <A, E>(use: (store: MessengerStore["Service"]) => Effect.Effect<A, E>) =>
    gw.runtime.runPromise(MessengerStore.use(use));

  const query = <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, import("effect/sql/SqlError").SqlError>) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, use));

  beforeAll(async () => {
    mcp = fakeConnector({
      userToken: true,
      tokenMetadata: () => ({ authed_user: { id: slackUser, scope: "tools" } }),
      refreshIssued: async () => {
        started?.();
        await hold;
      },
    });
    slack = slackOAuthFixture();
    gw = await startTestGateway({ messengerTransport: slack.transport });
    await gw.core.messengers.stop();
    await gw.api.saveConnectorOAuthApp({
      connectorType: "slack",
      ...mcp.registeredApp(oauthRedirectUrl()),
      issuer: mcp.issuer,
    });
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
    await mcp?.close();
    await slack?.close();
  });

  beforeEach(async () => {
    hold = undefined;
    started = undefined;
    slackUser = "U12345";

    for (const account of await messenger((s) => s.accounts(gw.userId)))
      await messenger((s) => s.deleteAccount(gw.userId, account.id));

    for (const account of (await gw.api.listConnectors({})).accounts)
      await gw.api.deleteConnectorAccount({ accountId: account.id });
  });

  async function authorize(accountId: string) {
    const begin = await gw.api.beginConnectorOAuth({ accountId, browserBinding: binding, redirectUri });
    const back = new URL((await fetch(begin.authorizationUrl, { redirect: "manual" })).headers.get("location")!);

    const result = await gw.api.completeConnectorOAuth({
      state: back.searchParams.get("state")!,
      code: back.searchParams.get("code")!,
      browserBinding: binding,
      issuer: mcp.issuer,
    });

    expect(result.error).toBe("");
  }

  async function setup() {
    const account = (
      await gw.api.saveConnectorAccount({ connectorType: "slack", name: "Slack user", url: mcp.url, authKind: "oauth" })
    ).account!;

    await authorize(account.id);

    return account.id;
  }

  const credentials = (id: string) => connector((s) => s.owned(gw.userId, id).pipe(Effect.flatMap(s.credentials)));

  async function expire(id: string, legacy = false) {
    await connector((s) =>
      s.transaction(
        Effect.gen(function* () {
          const row = yield* s.owned(gw.userId, id, true);
          const value = yield* s.credentials(row);

          if (legacy) {
            delete value.oauthSubject;
            delete value.oauthPublicOrigins;
          }

          value.expiresAt = Date.now() - 1000;
          yield* s.updateCredentials(row, value);
        }),
      ),
    );
  }

  async function subscription(id: string) {
    const linked = (
      await gw.api.saveMessengerAccount({ name: "Messages", connectorAccountId: id, appToken: "xapp-fixture" })
    ).account!;

    const begin = await gw.api.beginConnectorOAuth({
      accountId: id,
      browserBinding: binding,
      redirectUri,
      slackMessaging: true,
    });

    expect(
      (await gw.api.completeConnectorOAuth({ ...slack.consent(begin.authorizationUrl), browserBinding: binding }))
        .error,
    ).toBe("");

    const bot = await gw.core.bots.create(
      create(bots.CreateBotRequestSchema, {
        clientRequestId: crypto.randomUUID(),
        configuration: {
          name: `Refresh subscriber ${crypto.randomUUID()}`,
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "gpt-6.1-sol",
          shape: "round",
          color: "#22aaff",
        },
      }),
    );

    const route = await messenger((s) =>
      s.saveRoute(gw.userId, {
        botId: bot.id,
        accountId: linked.id,
        channelIds: ["C1"],
        userIds: ["UOWNER"],
        directMessages: false,
        mentions: true,
        observe: false,
        delivery: "notify",
        instructions: "Keep this subscription",
      }),
    );

    return { linked, route };
  }

  test("concurrent alias callers share a committed refresh and preserve subscriptions plus metadata edits", async () => {
    const id = await setup();
    const f = await subscription(id);
    const alias = crypto.randomUUID();
    await query(
      (sql) => sql`INSERT INTO config_items(owner_user_id,kind,global_id,local_id,revision)
      VALUES(${gw.userId}::uuid,'connector',${id},${id},1) ON CONFLICT DO NOTHING`,
    );
    await query(
      (sql) => sql`INSERT INTO config_aliases(owner_user_id,kind,alias_id,global_id)
      VALUES(${gw.userId}::uuid,'connector',${alias},${id})`,
    );
    const account = await connector((s) => s.owned(gw.userId, id));
    await gw.api.setConnectorAccess({
      accountId: id,
      expectedRevision: BigInt(account.revision),
      workerIds: [gw.workerId],
      botIds: [f.route.botId],
    });
    await expire(id, true);
    expect((await credentials(alias)).oauthSubject).toBeUndefined();
    const consumed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    started = consumed.resolve;
    hold = release.promise;
    const before = mcp.refreshes;
    const probing = gw.api.testConnector({ accountId: alias });
    const pending: PromiseLike<object>[] = [probing];
    void probing.catch(consumed.reject);

    try {
      await Promise.race([
        consumed.promise,
        probing.then(() => {
          throw new Error("Connector test finished before the refresh barrier");
        }),
      ]);
      const callers = Array.from({ length: 6 }, () => slackUserCredentials(gw.runtime, gw.userId, alias, false));
      pending.push(...callers);
      const refreshing = Promise.all(callers);
      pending.push(refreshing);
      void refreshing.catch(consumed.reject);
      const row = await connector((s) => s.owned(gw.userId, id));
      expect(row.slack_refresh_attempt).toBeTruthy();

      const saved = await gw.api.saveConnectorAccount({
        id,
        name: "Renamed while refreshing",
        expectedRevision: BigInt(row.revision),
      });

      expect(saved.account?.name).toBe("Renamed while refreshing");
      expect((await connector((s) => s.owned(gw.userId, id))).slack_refresh_attempt).toBeTruthy();
      release.resolve();
      const values = await refreshing;
      expect((await probing).account?.status).toBe("connected");
      expect(mcp.refreshes).toBe(before + 1);
      expect(new Set(values.map((result) => digest(result.value.tokens?.refresh_token ?? ""))).size).toBe(1);
      expect(values.every((result) => result.row.id === id && !!result.value.oauthSubject)).toBe(true);
      const savedAccount = (await gw.api.listConnectors({})).accounts.find((a) => a.id === id);
      expect(savedAccount?.workerIds).toContain(gw.workerId);
      expect(savedAccount?.botIds).toContain(f.route.botId);
      expect((await connector((s) => s.owned(gw.userId, id))).slack_refresh_attempt).toBeNull();
      expect((await connector((s) => s.owned(gw.userId, id))).name).toBe("Renamed while refreshing");
      expect(await messenger((s) => s.routes(gw.userId, f.route.botId))).toEqual([f.route]);
      expect(await messenger((s) => s.active(gw.userId, f.linked.id))).toBe(true);
      expect((await gw.api.testConnector({ accountId: alias })).account?.status).toBe("connected");
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      hold = undefined;
      started = undefined;
    }
  }, 30_000);

  test("a refresh issued for another Slack user cannot replace the authorized credentials", async () => {
    const id = await setup();
    const original = await credentials(id);
    await expire(id);
    slackUser = "UOTHER";
    await expect(slackUserCredentials(gw.runtime, gw.userId, id, false)).rejects.toThrow("Connector needs reconnect");
    expect((await connector((s) => s.owned(gw.userId, id))).status).toBe("needs_reconnect");
    const saved = await credentials(id);
    expect(saved.oauthSubject).toBe(original.oauthSubject);
    expect(saved.tokens?.refresh_token === original.tokens?.refresh_token).toBe(true);
  });

  test("a consumed refresh with a lost response survives gateway restart without replay", async () => {
    const id = await setup();
    await expire(id);
    const previous = digest((await credentials(id)).tokens?.refresh_token ?? "");
    const consumed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hold = release.promise;
    started = consumed.resolve;
    const before = mcp.refreshes;

    const refreshing = slackUserCredentials(gw.runtime, gw.userId, id, false);
    void refreshing.catch(consumed.reject);

    try {
      await Promise.race([
        consumed.promise,
        refreshing.then(() => {
          throw new Error("Refresh finished before the HTTP barrier");
        }),
      ]);
      expect((await connector((s) => s.owned(gw.userId, id))).slack_refresh_attempt).toBeTruthy();

      const storage = {
        pg: gw.pg,
        secretsKey: gw.secretsKey,
        workerId: gw.workerId,
        workerCredential: gw.workerCredential,
      };

      await gw.close(true);
      release.resolve();
      await expect(refreshing).rejects.toThrow("Connector needs reconnect");
      gw = await startTestGateway({ storage, messengerTransport: slack.transport });
      await gw.core.messengers.stop();
      await query(
        (sql) =>
          sql`UPDATE connector_accounts SET slack_refresh_started_at=now()-interval '1 minute' WHERE id=${id}::uuid`,
      );
      await expect(slackUserCredentials(gw.runtime, gw.userId, id, false)).rejects.toThrow("Connector needs reconnect");
      expect(mcp.refreshes).toBe(before + 1);
      expect(digest((await credentials(id)).tokens?.refresh_token ?? "")).toBe(previous);
      expect((await connector((s) => s.owned(gw.userId, id))).status).toBe("needs_reconnect");
      await authorize(id);
      expect((await connector((s) => s.owned(gw.userId, id))).slack_refresh_attempt).toBeNull();
      expect((await gw.api.testConnector({ accountId: id })).account?.status).toBe("connected");
    } finally {
      release.resolve();
      await Promise.allSettled([refreshing]);
      hold = undefined;
      started = undefined;
    }
  }, 30_000);

  test("credential replacement and fresh authorization fence late refresh settlement", async () => {
    const id = await setup();
    await expire(id);
    const consumed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hold = release.promise;
    started = consumed.resolve;

    const refreshing = slackUserCredentials(gw.runtime, gw.userId, id, false);
    void refreshing.catch(consumed.reject);

    let replacement = "";

    try {
      await Promise.race([
        consumed.promise,
        refreshing.then(() => {
          throw new Error("Refresh finished before the HTTP barrier");
        }),
      ]);
      const row = await connector((s) => s.owned(gw.userId, id));
      await gw.api.saveConnectorAccount({
        id,
        name: row.name,
        replaceCredentials: true,
        expectedRevision: BigInt(row.revision),
      });
      await authorize(id);
      replacement = digest((await credentials(id)).tokens?.refresh_token ?? "");
    } finally {
      release.resolve();
      await Promise.allSettled([refreshing]);
      hold = undefined;
      started = undefined;
    }

    await expect(refreshing).rejects.toThrow("Connector needs reconnect");
    expect(digest((await credentials(id)).tokens?.refresh_token ?? "")).toBe(replacement);
    expect((await connector((s) => s.owned(gw.userId, id))).status).toBe("connected");
    expect((await gw.api.testConnector({ accountId: id })).account?.status).toBe("connected");
  }, 30_000);
});
