import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { create, type JsonObject } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { applyConnector } from "../../apps/gateway/src/config-sync/connector-apply.ts";
import { emptyRecord } from "../../apps/gateway/src/config-sync/persistence.ts";
import { storeSecret } from "../../apps/gateway/src/config-sync/secrets.ts";
import { GatewayStore } from "@canopy/gateway/store";
import { MessengerStore } from "../../apps/gateway/src/messengers/store.ts";
import { encryptSecret } from "../../apps/gateway/src/store/secrets.ts";
import { oauthRedirectUrl } from "../../apps/gateway/src/connectors/catalog.ts";
import { slackOAuthFixture } from "./support/slack-oauth.ts";
import { fakeConnector } from "./support/connector.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

const binding = "s".repeat(43);
const redirectUri = "http://127.0.0.1:19112/api/connectors/oauth/callback";

describe.skipIf(!dockerAvailable)("shared Slack app and rotating bot authorization", () => {
  let gw: TestGateway;
  let slack: ReturnType<typeof slackOAuthFixture>;
  let mcp: ReturnType<typeof fakeConnector>;
  let app: { clientId: string; clientSecret: string };
  let mcpTeamId = "T12345";

  const messenger = <A, E>(use: (s: MessengerStore["Service"]) => Effect.Effect<A, E>) =>
    gw.runtime.runPromise(MessengerStore.use(use));

  const connector = <A, E>(use: (s: GatewayStore["Service"]["connectors"]) => Effect.Effect<A, E>) =>
    gw.runtime.runPromise(GatewayStore.use((s) => use(s.connectors)));

  const sqlRun = <A>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, import("effect/sql/SqlError").SqlError>) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, use));

  beforeAll(async () => {
    slack = slackOAuthFixture();
    mcp = fakeConnector({
      userToken: true,
      exchangeResponse: async () =>
        mcpTeamId === "T12345"
          ? undefined
          : Response.json({
              access_token: "xoxp-reconnected-workspace",
              refresh_token: "refresh-reconnected-workspace",
              token_type: "user",
              expires_in: 3600,
              ok: true,
              team: { id: mcpTeamId },
              authed_user: { id: "UOTHER", scope: "tools" },
            }),
    });
    gw = await startTestGateway({ messengerTransport: slack.transport });
    await gw.core.messengers.stop();
    app = mcp.registeredApp(oauthRedirectUrl());
    await gw.api.saveConnectorOAuthApp({ connectorType: "slack", ...app, issuer: mcp.issuer });
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    slack?.close();
    mcp?.close();
  });
  beforeEach(async () => {
    mcpTeamId = "T12345";
    slack.teamId = "T12345";
    slack.appId = "A1";
    slack.socketAppId = "A1";
    slack.rejectRefresh = false;
    slack.holdRefresh = undefined;
    slack.refreshStarted = undefined;

    for (const account of await messenger((s) => s.accounts(gw.userId)))
      await messenger((s) => s.deleteAccount(gw.userId, account.id));

    for (const account of (await gw.api.listConnectors({})).accounts)
      await gw.api.deleteConnectorAccount({ accountId: account.id });
  });

  async function routeFor(accountId: string) {
    const bot = await gw.core.bots.create(
      create(bots.CreateBotRequestSchema, {
        clientRequestId: crypto.randomUUID(),
        configuration: {
          name: `Legacy subscriptions ${crypto.randomUUID()}`,
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "gpt-6.1-sol",
          shape: "round",
          color: "#22aaff",
        },
      }),
    );

    return messenger((s) =>
      s.saveRoute(gw.userId, {
        accountId,
        botId: bot.id,
        channelIds: ["C1"],
        userIds: ["UOWNER"],
        directMessages: false,
        mentions: true,
        observe: true,
        delivery: "notify",
        instructions: "Keep the subscription",
      }),
    );
  }

  async function setup(legacy = false, missingTeam = false) {
    const account = (
      await gw.api.saveConnectorAccount({
        connectorType: "slack",
        name: "Shared Slack",
        url: mcp.url,
        authKind: "oauth",
      })
    ).account!;

    const start = await gw.api.beginConnectorOAuth({ accountId: account.id, browserBinding: binding, redirectUri });
    const back = new URL((await fetch(start.authorizationUrl, { redirect: "manual" })).headers.get("location")!);

    const user = await gw.api.completeConnectorOAuth({
      state: back.searchParams.get("state")!,
      code: back.searchParams.get("code")!,
      browserBinding: binding,
      issuer: mcp.issuer,
    });

    expect(user.error).toBe("");

    const old = legacy
      ? await messenger((s) =>
          s.saveAccount(gw.userId, {
            name: "Installed Slack",
            externalId: "T12345:B1",
            appToken: "xapp-fixture",
            botToken: "xoxb-fixture",
          }),
        )
      : undefined;

    const route = old ? await routeFor(old.id) : undefined;

    if (missingTeam)
      await connector((s) =>
        Effect.gen(function* () {
          const row = yield* s.owned(gw.userId, account.id);
          const credentials = yield* s.credentials(row);
          delete credentials.slackTeamId;
          yield* s.updateCredentials(row, credentials);
        }),
      );

    const linked = (
      await gw.api.saveMessengerAccount({
        ...(old && { id: old.id }),
        name: "Shared messages",
        connectorAccountId: account.id,
        ...(!old && { appToken: "xapp-fixture" }),
      })
    ).account!;

    expect(linked.status).toBe("needs_authorization");

    const pending = await gw.api.beginConnectorOAuth({
      accountId: account.id,
      browserBinding: binding,
      redirectUri,
      slackMessaging: true,
    });

    expect(new URL(pending.authorizationUrl).pathname).toBe("/oauth/v2/authorize");
    expect(new URL(pending.authorizationUrl).searchParams.get("client_id")).toBe(app.clientId);
    expect(new URL(pending.authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");

    return { account, linked, route, pending: slack.consent(pending.authorizationUrl) };
  }

  const complete = (pending: { code: string; state: string }, browserBinding = binding) =>
    gw.api.completeConnectorOAuth({ ...pending, browserBinding });

  const expire = async (id: string) => {
    const value = await messenger((s) => s.savedCredentials(gw.userId, id));
    await sqlRun(
      (sql) =>
        sql`UPDATE messenger_accounts SET credentials=${encryptSecret(gw.secretsKey, JSON.stringify({ ...value, expiresAt: Date.now() + 45_000 }))} WHERE id=${id}::uuid`,
    );
  };

  test("same registered app preserves MCP user tokens, requires consent, binds browser and receipts, then rotates once concurrently", async () => {
    const f = await setup();
    const userTokens = await connector((s) => s.owned(gw.userId, f.account.id).pipe(Effect.flatMap(s.credentials)));
    await expect(messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))).rejects.toThrow(
      "authorization",
    );
    expect(await messenger((s) => s.claimAccount(gw.userId, f.linked.id, "pending", new Date()))).toBeUndefined();
    expect((await complete(f.pending, "w".repeat(43))).failure?.kind).toBe("oauth_binding");
    const exchanges = slack.exchanges;
    expect((await complete(f.pending)).error).toBe("");
    expect((await complete(f.pending)).alreadyConnected).toBe(true);
    expect(slack.exchanges).toBe(exchanges + 1);
    expect(await connector((s) => s.owned(gw.userId, f.account.id).pipe(Effect.flatMap(s.credentials)))).toEqual(
      userTokens,
    );
    expect(slack.requests.at(-1)?.get("client_secret")).toBe(app.clientSecret);
    const view = (await gw.api.listMessengerAccounts({})).accounts[0]!;
    expect(view.id).toBe(f.linked.id);
    expect(view.connectorAccountId).toBe(f.account.id);
    expect(JSON.stringify(view)).not.toContain("xapp-");
    expect(JSON.stringify(view)).not.toContain("xoxe");
    const lease = await messenger((s) => s.claimAccount(gw.userId, f.linked.id, "fixture", new Date()));
    await expire(f.linked.id);
    const refreshes = slack.refreshes;

    const values = await Promise.all(
      Array.from({ length: 8 }, () => messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))),
    );

    expect(new Set(values.map((v) => v.botToken)).size).toBe(1);
    expect(slack.refreshes).toBe(refreshes + 1);
    expect(Object.keys(values[0]!).sort()).toEqual(["appToken", "botToken"]);
    expect(await messenger((s) => s.renewAccount(gw.userId, lease!, new Date()))).toBe(true);

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({ storage, messengerTransport: slack.transport });
    await gw.core.messengers.stop();
    expect(await messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))).toEqual(values[0]!);
    expect(slack.refreshes).toBe(refreshes + 1);
  }, 30_000);

  test("API metadata saves during refresh preserve its durable single-use claim and rotated tokens", async () => {
    const f = await setup();
    await complete(f.pending);
    await expire(f.linked.id);
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    slack.holdRefresh = held.promise;
    slack.refreshStarted = started.resolve;
    const refreshes = slack.refreshes;
    const refreshing = messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport));
    void refreshing.catch(started.reject);

    try {
      await Promise.race([
        started.promise,
        refreshing.then(() => {
          throw new Error("Refresh finished before the HTTP barrier");
        }),
      ]);
      const view = (await gw.api.saveMessengerAccount({ id: f.linked.id, name: "Renamed during rotation" })).account!;
      expect(view.status).toBe("connecting");

      const marker = await sqlRun(
        (sql) =>
          sql<{
            refresh_attempt: string | null;
          }>`SELECT refresh_attempt FROM messenger_accounts WHERE id=${f.linked.id}::uuid`,
      );

      expect(marker[0]?.refresh_attempt).toBeTruthy();
      held.resolve();
      const rotated = await refreshing;
      expect(await messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))).toEqual(rotated);
      expect(slack.refreshes).toBe(refreshes + 1);
    } finally {
      held.resolve();
      await Promise.allSettled([refreshing]);
      slack.holdRefresh = undefined;
      slack.refreshStarted = undefined;
    }
  }, 30_000);

  test("metadata waiting on its connector rereads credentials after a concurrent refresh commits", async () => {
    const f = await setup();
    await complete(f.pending);
    await expire(f.linked.id);
    const httpStarted = Promise.withResolvers<void>();
    const httpRelease = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<number>();
    const unlock = Promise.withResolvers<void>();
    slack.holdRefresh = httpRelease.promise;
    slack.refreshStarted = httpStarted.resolve;
    const refreshing = messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport));
    const pending: PromiseLike<object | void>[] = [refreshing];
    void refreshing.catch(httpStarted.reject);

    try {
      await Promise.race([
        httpStarted.promise,
        refreshing.then(() => {
          throw new Error("Refresh finished before the HTTP barrier");
        }),
      ]);

      const holding = sqlRun((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM connector_accounts WHERE id=${f.account.id}::uuid FOR UPDATE`;
            const rows = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
            locked.resolve(rows[0]!.pid);
            yield* Effect.promise(() => unlock.promise);
          }),
        ),
      );

      pending.push(holding);
      void holding.catch(locked.reject);

      const blockingPid = await Promise.race([
        locked.promise,
        holding.then(() => {
          throw new Error("Connector lock released before the barrier");
        }),
      ]);

      const saving = gw.api.saveMessengerAccount({ id: f.linked.id, name: "Rename while waiting" });
      pending.push(saving);

      const saveFinished = saving.then(() => {
        throw new Error("Metadata save finished before waiting on the connector lock");
      });

      pending.push(saveFinished);
      const deadline = Date.now() + 5000;

      for (;;) {
        const waiting = await Promise.race([
          sqlRun(
            (sql) => sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND ${blockingPid}=ANY(pg_blocking_pids(pid))`,
          ),
          saveFinished,
        ]);

        if (waiting.length) break;

        if (Date.now() > deadline) throw new Error("Metadata did not reach the connector lock");
        await delay(5);
      }

      httpRelease.resolve();
      const rotated = await refreshing;
      unlock.resolve();
      await holding;
      await saving;
      expect(await messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))).toEqual(rotated);
    } finally {
      httpRelease.resolve();
      unlock.resolve();
      await Promise.allSettled(pending);
      slack.holdRefresh = undefined;
      slack.refreshStarted = undefined;
    }
  }, 30_000);

  test("rejected refresh and abandoned claim fail closed across gateway restart without replay", async () => {
    const f = await setup();
    await complete(f.pending);
    await expire(f.linked.id);
    const refreshes = slack.refreshes;
    slack.rejectRefresh = true;
    await expect(messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))).rejects.toThrow("reconnect");
    await expect(messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))).rejects.toThrow();
    expect(slack.refreshes).toBe(refreshes + 1);

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({ storage, messengerTransport: slack.transport });
    await gw.core.messengers.stop();
    await expect(messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))).rejects.toThrow();
    expect(slack.refreshes).toBe(refreshes + 1);
    await sqlRun(
      (sql) =>
        sql`UPDATE messenger_accounts SET status='connecting',refresh_attempt=gen_random_uuid(),refresh_started_at=now()-interval '1 minute' WHERE id=${f.linked.id}::uuid`,
    );
    await expect(messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))).rejects.toThrow("reconnect");
    expect(slack.refreshes).toBe(refreshes + 1);
  }, 30_000);

  for (const mismatch of ["team", "app", "socket"] as const)
    test(`rejects mismatched ${mismatch} identity without replacing MCP tokens`, async () => {
      const f = await setup();

      if (mismatch === "team") slack.teamId = "TOTHER";

      if (mismatch === "app") slack.appId = "AOTHER";

      if (mismatch === "socket") slack.socketAppId = "AOTHER";
      expect((await complete(f.pending)).error).toContain("Slack authorization failed");
      expect((await messenger((s) => s.accounts(gw.userId)))[0]?.status).toBe("needs_authorization");
      expect((await gw.api.listConnectors({})).accounts[0]?.status).toBe("connected");
    });

  test("legacy accounts link in place and revision changes invalidate pending authorization", async () => {
    const f = await setup(true);
    const before = (await messenger((s) => s.accounts(gw.userId)))[0]!;

    const updated = await gw.api.saveMessengerAccount({
      id: before.id,
      name: "Rotate app token",
      appToken: "xapp-replaced",
    });

    expect(updated.account?.id).toBe(f.linked.id);
    expect((await complete(f.pending)).error).toContain("Slack authorization failed");

    const start = await gw.api.beginConnectorOAuth({
      accountId: f.account.id,
      browserBinding: binding,
      redirectUri,
      slackMessaging: true,
    });

    expect((await complete(slack.consent(start.authorizationUrl))).error).toBe("");
    expect((await messenger((s) => s.accounts(gw.userId)))[0]?.id).toBe(f.linked.id);
    expect(await messenger((s) => s.routes(gw.userId, f.route!.botId))).toEqual([f.route!]);
  });

  test("legacy MCP tokens without workspace metadata resolve their user identity before authorizing a bot", async () => {
    const f = await setup(false, true);
    slack.teamId = "TOTHER";
    expect((await complete(f.pending)).error).toContain("Slack authorization failed");
    expect((await messenger((s) => s.accounts(gw.userId)))[0]?.status).toBe("needs_authorization");
  });

  test("new linked setup adopts an installed workspace bot without replacing its subscriptions", async () => {
    const f = await setup();

    const legacy = await messenger((s) =>
      s.saveAccount(gw.userId, {
        name: "Installed workspace",
        externalId: "T12345:B1",
        appToken: "xapp-fixture",
        botToken: "xoxb-fixture",
      }),
    );

    const route = await routeFor(legacy.id);
    expect((await complete(f.pending)).error).toBe("");
    expect((await messenger((s) => s.accounts(gw.userId))).map((a) => a.id)).toEqual([legacy.id]);
    expect(await messenger((s) => s.routes(gw.userId, route.botId))).toEqual([route]);
    expect((await complete(f.pending)).alreadyConnected).toBe(true);
    await gw.api.disconnectConnector({ accountId: f.account.id });
    expect((await complete(f.pending)).alreadyConnected).toBe(false);
  });

  test("pending subscriptions block automatic adoption before exchange and remain attached to their account", async () => {
    const f = await setup();
    const pendingRoute = await routeFor(f.linked.id);

    const legacy = await messenger((s) =>
      s.saveAccount(gw.userId, {
        name: "Installed workspace",
        externalId: "T12345:B1",
        appToken: "xapp-fixture",
        botToken: "xoxb-fixture",
      }),
    );

    const installedRoute = await routeFor(legacy.id);
    const exchanges = slack.exchanges;
    expect((await complete(f.pending)).error).toContain("Link the installed Slack messenger account");
    expect(slack.exchanges).toBe(exchanges);
    expect(await messenger((s) => s.routes(gw.userId, pendingRoute.botId))).toEqual([pendingRoute]);
    expect(await messenger((s) => s.routes(gw.userId, installedRoute.botId))).toEqual([installedRoute]);
    expect(await messenger((s) => s.accounts(gw.userId))).toHaveLength(2);
  });

  test("a non-Slack OAuth account cannot send its token to Slack through the messaging flag", async () => {
    const account = (
      await gw.api.saveConnectorAccount({
        connectorType: "custom",
        name: "Other service",
        url: mcp.url,
        authKind: "oauth",
      })
    ).account!;

    const pending = await gw.api.beginConnectorOAuth({ accountId: account.id, browserBinding: binding, redirectUri });
    const back = new URL((await fetch(pending.authorizationUrl, { redirect: "manual" })).headers.get("location")!);
    expect(
      (await complete({ state: back.searchParams.get("state")!, code: back.searchParams.get("code")! })).error,
    ).toBe("");
    const requests = slack.methods.length;

    const rejected = await gw.api
      .beginConnectorOAuth({ accountId: account.id, browserBinding: binding, redirectUri, slackMessaging: true })
      .then(
        () => "unexpected authorization",
        (cause: Error) => cause.message,
      );

    expect(rejected).toContain("Choose a Slack connection");
    expect(slack.methods).toHaveLength(requests);
  });

  test("MCP OAuth changing workspace suspends the linked messenger while same-workspace refresh leaves it available", async () => {
    const f = await setup();
    await complete(f.pending);
    await connector((s) =>
      s.transaction(
        Effect.gen(function* () {
          const row = yield* s.owned(gw.userId, f.account.id, true);
          const credentials = yield* s.credentials(row);
          yield* s.updateCredentials(row, {
            ...credentials,
            tokens: { ...credentials.tokens!, access_token: "xoxp-same-team-refresh" },
          });
        }),
      ),
    );
    expect(await messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))).toBeDefined();
    mcpTeamId = "TOTHER";
    const pending = await gw.api.beginConnectorOAuth({ accountId: f.account.id, browserBinding: binding, redirectUri });
    const back = new URL((await fetch(pending.authorizationUrl, { redirect: "manual" })).headers.get("location")!);
    expect(
      (await complete({ state: back.searchParams.get("state")!, code: back.searchParams.get("code")! })).error,
    ).toBe("");
    expect((await messenger((s) => s.accounts(gw.userId)))[0]?.status).toBe("needs_authorization");
    await expect(messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))).rejects.toThrow(
      "authorization",
    );
  });

  test("replicated Slack credentials changing workspace revoke local messenger authorization", async () => {
    const f = await setup();
    await complete(f.pending);
    const credentials = await connector((s) => s.owned(gw.userId, f.account.id).pipe(Effect.flatMap(s.credentials)));

    const remote = {
      ...credentials,
      slackTeamId: "TOTHER",
      tokens: { ...credentials.tokens!, access_token: "xoxp-remote-workspace" },
    };

    const record = emptyRecord("connector", f.account.id);

    const values: JsonObject = {
      type: "slack",
      name: "Shared Slack",
      url: mcp.url,
      transport: "http",
      authKind: "oauth",
      allWorkers: false,
      allBots: false,
      tools: [],
      credentials: "remote-secret-version",
    };

    for (const [name, value] of Object.entries(values))
      record.fields[name] = { value, hlc: "remote-workspace-version", prev: "" };
    await gw.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* storeSecret(
              sql,
              gw.userId,
              record,
              "credentials",
              "remote-workspace-version",
              encryptSecret(gw.secretsKey, JSON.stringify(remote)),
            );
            yield* applyConnector(sql, gw.userId, gw.secretsKey, record);
          }),
        ),
      ),
    );
    expect(record.unsupported).toBe("");
    expect((await messenger((s) => s.accounts(gw.userId)))[0]?.status).toBe("needs_authorization");
    await expect(messenger((s) => s.credentials(gw.userId, f.linked.id, slack.transport))).rejects.toThrow(
      "authorization",
    );
  });

  test("owner mismatch cannot read, link, claim or consume another owner's setup", async () => {
    const f = await setup();
    const other = crypto.randomUUID();
    await expect(messenger((s) => s.savedCredentials(other, f.linked.id))).rejects.toThrow("not found");
    await expect(connector((s) => s.consumeState(other, f.pending.state, binding))).rejects.toThrow(
      "no longer available",
    );
    await expect(
      messenger((s) =>
        s.saveAccount(other, {
          connectorAccountId: f.account.id,
          name: "Forged",
          externalId: "",
          appToken: "xapp-forged",
        }),
      ),
    ).rejects.toThrow();
    expect(await messenger((s) => s.claimAccount(other, f.linked.id, "forged", new Date()))).toBeUndefined();
    expect((await complete(f.pending)).error).toBe("");
  });
});
