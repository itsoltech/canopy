import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toJson } from "@bufbuild/protobuf";
import { bots, connectors, MentionKind, PermissionMode, Provider, ProviderProfileKind } from "@canopy/contracts";
import type { ModelInput } from "../../apps/gateway/src/bots/types.ts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pastedCode, returnState, returnTarget } from "@canopy/domain/oauth-return";
import { DEFAULT_OAUTH_REDIRECT_URL } from "../../apps/gateway/src/connectors/catalog.ts";
import { SLACK_USER_SCOPES } from "../../apps/gateway/src/connectors/slack-app.ts";
import { fakeConnector } from "./support/connector.ts";
import { eventually, startTestGateway, type TestGateway, type ScriptedWorker } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("connectors: OAuth, gateway grants and worker bridge", () => {
  let gw: TestGateway;
  let fake: ReturnType<typeof fakeConnector>;

  let projectId = "",
    workspaceId = "",
    deniedWorkspace = "";

  let deniedWorker: ScriptedWorker;
  const seen: ModelInput[] = [];
  let automaticTool = "";

  const query = <A extends object>(text: string, ...params: unknown[]) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, params);
      }),
    );

  const save = async (name: string, authKind = "headers") =>
    (
      await gw.api.saveConnectorAccount({
        connectorType: "custom",
        name,
        url: fake.url,
        authKind,
        token: authKind === "headers" ? fake.secret : "",
      })
    ).account!;

  const grant = async (account: connectors.ConnectorAccount, botIds: string[] = []) =>
    (
      await gw.api.setConnectorAccess({
        accountId: account.id,
        expectedRevision: account.revision,
        workerIds: [gw.workerId],
        botIds,
      })
    ).account!;

  const thread = async (permissionMode = PermissionMode.FULL_AUTO, workspace = workspaceId) => {
    const t = (
      await gw.api.createThread({
        projectId,
        workspaceId: workspace,
        provider: Provider.CODEX,
        permissionMode,
        title: "Connector test",
        initialMessage: "Use connector",
      })
    ).thread!;

    const turns = await eventually(
      () => query<{ id: string; status: string }>("SELECT id,status FROM turns WHERE thread_id=$1::uuid", t.id),
      (r) => r[0]?.status === "running",
    );

    return { id: t.id, turnId: turns[0]!.id };
  };

  const call = (
    t: { id: string; turnId: string },
    accountId: string,
    tool: string,
    callId?: string,
    marker = "CANOPY_CONNECTOR_OK",
  ) =>
    gw.worker.callTool({
      threadId: t.id,
      turnId: t.turnId,
      connectorAccountId: accountId,
      tool,
      args: { marker },
      ...(callId && { callId }),
    });

  beforeAll(async () => {
    fake = fakeConnector();
    gw = await startTestGateway({
      botModel: async (input) => {
        seen.push(input);

        if (
          automaticTool &&
          input.configuration.name === "Automatic connector bot" &&
          input.messages.at(-1)?.role === "user"
        )
          return {
            text: "",
            calls: [{ id: "automatic-write", name: automaticTool, arguments: { marker: "AUTOMATIC_WRITE" } }],
          };

        return { text: "Ready", calls: [] };
      },
    });
    gw.worker.holdTurns = true;
    gw.core.bots.start();
    await gw.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "connector-test",
      label: "Fixture",
      create: true,
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:1",
      apiKey: "fixture",
      allWorkers: true,
    });
    await eventually(
      () => gw.core.bots.run((s) => s.harnessModels(Provider.CODEX, "connector-test")),
      (models) => models.some((m) => m.id === "gpt-6.1-sol"),
    );
    projectId = (await gw.api.createProject({ name: "Connectors" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
    const other = await gw.addWorker("denied", ["/repo"]);
    deniedWorker = await gw.connect(other.workerId, other.credential);
    deniedWorker.holdTurns = true;
    deniedWorkspace = (await gw.api.createWorkspace({ projectId, workerId: other.workerId, rootPath: "/repo" }))
      .workspace!.id;
  }, 60_000);
  afterAll(async () => {
    await fake?.close();
    await gw?.close();
  });

  test("connect → grant → bridge; deduplication, audit, redaction and permission modes", async () => {
    let account = await save("work");
    const tools = (await gw.api.testConnector({ accountId: account.id })).tools;

    const read = tools.find((t) => t.remoteName === "read_marker")!,
      write = tools.find((t) => t.remoteName === "write_marker")!;

    expect(read.description).toContain("work");
    const unavailable = await thread();
    expect((await call(unavailable, account.id, read.name)).isError).toBe(true);
    account = await grant(account);
    const t = await thread();

    const callId = Bun.randomUUIDv7(),
      before = fake.calls.length;

    const first = await call(t, account.id, read.name, callId);
    expect(first.isError).toBe(false);
    expect(first.content).toContain("CANOPY_CONNECTOR_OK");
    expect(first.content).not.toContain(fake.secret);
    expect(first.content).toContain("[REDACTED]");
    expect(JSON.parse((await call(t, account.id, read.name, callId)).content)).toEqual(JSON.parse(first.content));
    expect((await call(t, account.id, read.name, callId, "different")).isError).toBe(true);
    expect(fake.calls.length).toBe(before + 1);
    expect(JSON.stringify(gw.worker.commands)).toContain(read.name);
    expect(JSON.stringify(gw.worker.commands)).not.toContain(fake.secret);

    const audit = await query<{ tool: string; outcome: string; payload: string }>(
      "SELECT tool,outcome,row_to_json(a)::text AS payload FROM connector_audit a WHERE thread_id=$1::uuid",
      t.id,
    );

    expect(audit).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: "read_marker", outcome: "completed" })]),
    );
    expect(JSON.stringify(audit)).not.toContain("CANOPY_CONNECTOR_OK");
    expect(JSON.stringify(audit)).not.toContain(fake.secret);
    const ask = await thread(PermissionMode.ASK);
    const pendingId = Bun.randomUUIDv7();
    const waiting = call(ask, account.id, write.name, pendingId);

    const interaction = await eventually(
      () =>
        query<{ id: string; request: unknown }>(
          "SELECT id,request FROM interaction_requests WHERE id=$1::uuid",
          pendingId,
        ),
      (r) => !!r.length,
    );

    expect(JSON.stringify(interaction[0]!.request)).toContain("CANOPY_CONNECTOR_OK");
    expect(fake.calls.length).toBe(before + 1);
    await gw.api.answerInteraction({ requestId: pendingId, allow: true });
    expect((await waiting).isError).toBe(false);
    const readonly = await thread(PermissionMode.READ_ONLY);
    expect((await call(readonly, account.id, write.name)).isError).toBe(true);
    const denied = await thread(PermissionMode.FULL_AUTO, deniedWorkspace);
    expect((await call(denied, account.id, read.name)).isError).toBe(true);
    expect(
      (
        await deniedWorker.callTool({
          threadId: denied.id,
          turnId: denied.turnId,
          connectorAccountId: account.id,
          tool: read.name,
          args: { marker: "denied-worker" },
        })
      ).isError,
    ).toBe(true);
    // Revocation must reject even a previously completed call's replay.
    account = (await gw.api.setConnectorAccess({ accountId: account.id, expectedRevision: account.revision })).account!;
    expect((await call(t, account.id, read.name, callId)).isError).toBe(true);

    const otherUser = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("connector-other@test.local", "Other")),
    );

    await expect(gw.core.connectors.run((s) => s.owned(otherUser, account.id))).rejects.toThrow();

    const cipher = await query<{ credentials: Uint8Array }>(
      "SELECT credentials FROM connector_accounts WHERE id=$1::uuid",
      account.id,
    );

    expect(Buffer.from(cipher[0]!.credentials).toString()).not.toContain(fake.secret);
    // Delete: only the owner; the account, its grants and replay records go, audit rows stay unlinked.
    await expect(gw.core.connectors.run((s) => s.remove(otherUser, account.id))).rejects.toThrow();
    account = await grant(account);
    await gw.api.deleteConnectorAccount({ accountId: account.id });
    expect((await gw.api.listConnectors({})).accounts.some((a) => a.id === account.id)).toBe(false);
    expect(await query("SELECT 1 FROM connector_worker_grants WHERE account_id=$1::uuid", account.id)).toHaveLength(0);
    expect(await query("SELECT 1 FROM connector_audit WHERE thread_id=$1::uuid", t.id)).not.toHaveLength(0);
    expect((await call(t, account.id, read.name)).isError).toBe(true);
  }, 30_000);

  test("bot grants, model tools and canonical @ account mention", async () => {
    const configuration = create(bots.BotConfigurationSchema, {
      name: "Connector bot",
      shape: "round",
      color: "#22aaff",
      provider: Provider.CODEX,
      providerInstance: "connector-test",
      model: "gpt-6.1-sol",
    });

    const createRequest = { configuration, clientRequestId: Bun.randomUUIDv7() };
    const bot = (await gw.api.createBot(createRequest)).bot!;
    let account = await save("personal");
    const tool = (await gw.api.testConnector({ accountId: account.id })).tools[0]!;
    const source = { userId: gw.userId, botId: bot.id, accountId: account.id };
    await expect(
      gw.core.connectors.call(source, Bun.randomUUIDv7(), tool.name, { marker: "bot" }, AbortSignal.timeout(5000)),
    ).rejects.toThrow();

    const label = "Custom MCP server · personal",
      text = `Use @${label}`;

    const mention = { kind: MentionKind.CONNECTOR, name: account.id, label, start: 4, end: text.length };
    await expect(
      gw.core.bots.send(
        create(bots.SendBotMessageRequestSchema, {
          botId: bot.id,
          clientRequestId: Bun.randomUUIDv7(),
          text,
          mentions: [mention],
        }),
      ),
    ).rejects.toThrow("Connector access denied");
    account = await grant(account, [bot.id]);
    expect((await gw.core.connectors.botTools(bot.id)).some((t) => t.name === tool.name)).toBe(true);
    expect(
      JSON.stringify(
        await gw.core.connectors.call(
          source,
          Bun.randomUUIDv7(),
          tool.name,
          { marker: "bot" },
          AbortSignal.timeout(5000),
        ),
      ),
    ).toContain("bot");
    // Saving unrelated bot settings must preserve the connector grant.
    await gw.api.updateBot({ botId: bot.id, configuration: { ...configuration, instructions: "Keep grants" } });
    await gw.api.createBot(createRequest);
    expect((await gw.api.listConnectors({ botId: bot.id })).accounts.map((a) => a.id)).toContain(account.id);
    await gw.api.sendBotMessage({ botId: bot.id, clientRequestId: Bun.randomUUIDv7(), text, mentions: [mention] });
    await eventually(
      () => gw.core.bots.run((s) => s.conversation(gw.userId, bot.id)),
      (c) => !c.working,
    );
    const conversation = await gw.core.bots.run((s) => s.conversation(gw.userId, bot.id));
    expect(conversation.messages[0]!.mentions[0]).toMatchObject({
      kind: MentionKind.CONNECTOR,
      name: account.id,
      label,
      source: "custom",
    });
    expect(JSON.stringify(seen.at(-1))).toContain(account.id);
    expect(JSON.stringify(seen.at(-1))).not.toContain(fake.secret);
    account = (
      await gw.api.saveConnectorAccount({ id: account.id, expectedRevision: account.revision, name: "renamed" })
    ).account!;
    const renamed = (await gw.core.connectors.botTools(bot.id)).find((t) => t.name === tool.name)!;
    expect(renamed.description).toContain("Custom MCP server · renamed");
    expect(renamed.description).not.toContain("Custom MCP server · personal");
  }, 15_000);

  test("expired and declined OAuth flows cannot connect an account or be replayed", async () => {
    const account = await save("pending", "oauth");
    const browserBinding = "p".repeat(43);

    const pending = async () => {
      const begin = await gw.api.beginConnectorOAuth({
        accountId: account.id,
        browserBinding,
        redirectUri: "http://127.0.0.1:19111/api/connectors/oauth/callback",
      });

      const response = await fetch(begin.authorizationUrl, { redirect: "manual" });
      const callback = new URL(response.headers.get("location")!);

      return { browserBinding, state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")! };
    };

    const expired = await pending();
    await query(
      "UPDATE connector_oauth_states SET expires_at=now()-interval '1 second' WHERE account_id=$1::uuid",
      account.id,
    );
    expect((await gw.api.completeConnectorOAuth(expired)).error).not.toBe("");
    const declined = await pending();
    const denial = await gw.api.completeConnectorOAuth({ ...declined, error: "provider-controlled-error" });
    expect(denial.error).not.toContain("provider-controlled-error");
    expect(denial.account).toBeUndefined();
    expect((await gw.api.completeConnectorOAuth(declined)).error).not.toBe("");
    expect((await gw.api.listConnectors({})).accounts.find((a) => a.id === account.id)?.status).not.toBe("connected");
  });

  test("OAuth DCR + state/browser binding + S256, refresh rotation, reconnect and revoke", async () => {
    let account = await save("oauth", "oauth");
    const binding = crypto.randomUUID().replaceAll("-", "");

    const begin = () =>
      gw.api.beginConnectorOAuth({
        accountId: account.id,
        browserBinding: binding,
        redirectUri: "http://127.0.0.1:19111/api/connectors/oauth/callback",
      });

    const auth = new URL((await begin()).authorizationUrl);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(fake.registrations).toBeGreaterThan(0);
    const response = await fetch(auth, { redirect: "manual" });
    const callback = new URL(response.headers.get("location")!);

    const complete = {
      state: callback.searchParams.get("state")!,
      code: callback.searchParams.get("code")!,
      issuer: callback.searchParams.get("iss")!,
      browserBinding: binding,
    };

    expect((await gw.api.completeConnectorOAuth({ ...complete, browserBinding: "x".repeat(32) })).error).not.toBe("");

    const otherUser = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("oauth-other@test.local", "Other")),
    );

    await expect(gw.core.connectors.run((s) => s.consumeState(otherUser, complete.state, binding))).rejects.toThrow();
    expect((await gw.api.completeConnectorOAuth({ ...complete, state: "f".repeat(43) })).error).not.toBe("");
    fake.duration = 1;
    const accountId = account.id;

    const results = await Promise.all([
      gw.api.completeConnectorOAuth(complete),
      gw.api.completeConnectorOAuth(complete),
    ]);

    expect(results.filter((r) => r.account && !r.error)).toHaveLength(1);
    expect(results.filter((r) => r.error)).toHaveLength(1);
    account = results.find((r) => r.account)!.account!;
    expect(account.id).toBe(accountId);
    await expect(
      gw.core.connectors.complete(create(connectors.CompleteConnectorOAuthRequestSchema, complete)),
    ).rejects.toThrow();
    expect((await gw.api.completeConnectorOAuth(complete, { timeoutMs: 4000 })).error).not.toBe("");
    account = await grant(account);
    const before = fake.refreshes;
    const tools = (await gw.api.testConnector({ accountId: account.id })).tools;
    expect(fake.refreshes).toBe(before + 1);
    const t = await thread();
    const result = await call(t, account.id, tools[0]!.name);
    expect(result.isError).toBe(false);

    for (const token of fake.tokens) {
      expect(result.content).not.toContain(token);
      expect(JSON.stringify(gw.worker.commands)).not.toContain(token);
    }

    fake.rejectRefresh = true;
    await expect(gw.api.testConnector({ accountId: account.id })).rejects.toThrow();
    expect((await gw.api.listConnectors({})).accounts.find((a) => a.id === account.id)?.status).toBe("needs_reconnect");
    fake.rejectRefresh = false;
    fake.duration = 3600;

    const retry = new URL((await begin()).authorizationUrl),
      redirect = new URL((await fetch(retry, { redirect: "manual" })).headers.get("location")!);

    await gw.api.completeConnectorOAuth({
      browserBinding: binding,
      state: redirect.searchParams.get("state")!,
      code: redirect.searchParams.get("code")!,
    });
    await gw.api.disconnectConnector({ accountId: account.id });
    expect(fake.revoked.length).toBeGreaterThanOrEqual(2);
    expect((await call(t, account.id, tools[0]!.name)).isError).toBe(true);
    expect(
      (
        await query<{ credentials: unknown }>(
          "SELECT credentials FROM connector_accounts WHERE id=$1::uuid",
          account.id,
        )
      )[0]!.credentials,
    ).toBeNull();
  }, 60_000);

  test("full_auto bot writes despite stale read-only hints without an approval card", async () => {
    const bot = (
      await gw.api.createBot({
        clientRequestId: Bun.randomUUIDv7(),
        configuration: {
          name: "Automatic connector bot",
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "connector-test",
          model: "gpt-6.1-sol",
          approvalPolicy: "full_auto",
        },
      })
    ).bot!;

    const account = await grant(await save("automatic"), [bot.id]);
    fake.readOnlyTools = ["read_marker", "write_marker"];

    try {
      automaticTool = (await gw.api.testConnector({ accountId: account.id })).tools.find(
        (t) => t.remoteName === "write_marker",
      )!.name;
      fake.readOnlyTools = ["read_marker"];
      const before = fake.calls.length;
      await gw.api.sendBotMessage({
        botId: bot.id,
        clientRequestId: Bun.randomUUIDv7(),
        text: "Run the connector action",
      });

      const done = await eventually(
        () => gw.core.bots.run((s) => s.conversation(gw.userId, bot.id)),
        (c) => !c.working,
      );

      expect(done.approvals).toHaveLength(0);
      expect(fake.calls.slice(before)).toEqual([{ name: "write_marker", args: { marker: "AUTOMATIC_WRITE" } }]);
    } finally {
      automaticTool = "";
      fake.readOnlyTools = ["read_marker"];
    }
  }, 15_000);

  test("pre-registered confidential app uses its issuer and client secret only in the gateway", async () => {
    const redirectUri = "http://127.0.0.1:19111/api/connectors/oauth/callback";
    const app = fake.registeredApp(redirectUri);
    await gw.api.saveConnectorOAuthApp({ connectorType: "custom", issuer: fake.issuer, ...app });

    const account = await save("registered", "oauth"),
      browserBinding = "b".repeat(32);

    const registrations = fake.registrations;
    const begin = await gw.api.beginConnectorOAuth({ accountId: account.id, redirectUri, browserBinding });
    expect(fake.registrations).toBe(registrations);
    expect(begin.authorizationUrl).not.toContain(app.clientSecret);
    const callback = new URL((await fetch(begin.authorizationUrl, { redirect: "manual" })).headers.get("location")!);

    const result = await gw.api.completeConnectorOAuth({
      browserBinding,
      state: callback.searchParams.get("state")!,
      code: callback.searchParams.get("code")!,
    });

    expect(result.account?.status).toBe("connected");
    expect(result.error).toBe("");
    expect((await gw.api.testConnector({ accountId: account.id })).tools).toHaveLength(2);

    const stored = await query<{ credentials: Uint8Array }>(
      "SELECT credentials FROM connector_oauth_apps WHERE owner_user_id=$1::uuid",
      gw.userId,
    );

    expect(Buffer.from(stored[0]!.credentials).toString()).not.toContain(app.clientSecret);
    expect(
      JSON.stringify(toJson(connectors.ListConnectorsResponseSchema, await gw.api.listConnectors({}))),
    ).not.toContain(app.clientSecret);
  }, 15_000);

  test("registered apps return through the fixed redirect page; state carries the way back; codes are single-use", async () => {
    const fixed = DEFAULT_OAUTH_REDIRECT_URL;
    const callback = "http://127.0.0.1:19111/api/connectors/oauth/callback";
    const app = fake.registeredApp(fixed);
    await gw.api.saveConnectorOAuthApp({ connectorType: "github", issuer: fake.issuer, ...app });
    await gw.api.saveConnectorOAuthApp({ connectorType: "slack", issuer: fake.issuer, ...fake.registeredApp(fixed) });

    const catalog = await gw.api.listConnectors({});
    const slack = catalog.types.find((t) => t.id === "slack")!.authMethods[0]!;

    const manifest = JSON.parse(slack.appManifest) as {
      oauth_config: { redirect_urls: string[]; scopes: { user: string[] } };
    };

    expect(manifest.oauth_config.redirect_urls).toEqual([fixed]);
    expect(manifest.oauth_config.scopes.user).toEqual([...SLACK_USER_SCOPES]);
    expect(slack.defaultScope).toBe(SLACK_USER_SCOPES.join(" "));
    expect(new URL(slack.appCreateUrl).searchParams.get("manifest_json")).toBe(
      JSON.stringify(JSON.parse(slack.appManifest)),
    );
    expect(catalog.types.find((t) => t.id === "github")!.authMethods[1]!.redirectUrl).toBe(fixed);
    expect(JSON.stringify(toJson(connectors.ListConnectorsResponseSchema, catalog))).not.toContain(app.clientSecret);

    const account = (
      await gw.api.saveConnectorAccount({ connectorType: "github", name: "fixed", url: fake.url, authKind: "oauth" })
    ).account!;

    const browserBinding = "f".repeat(43);

    const begin = async (desktop = false) => {
      const request = { accountId: account.id, redirectUri: callback, browserBinding, desktop };
      const authorization = new URL((await gw.api.beginConnectorOAuth(request)).authorizationUrl);
      expect(authorization.searchParams.get("redirect_uri")).toBe(fixed);
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      const back = new URL((await fetch(authorization, { redirect: "manual" })).headers.get("location")!);
      expect(`${back.origin}${back.pathname}`).toBe(fixed);

      return { state: back.searchParams.get("state")!, code: back.searchParams.get("code")! };
    };

    const web = await begin();
    expect(returnTarget(`?state=${web.state}&code=${web.code}`)?.url).toStartWith(`${callback}?`);
    const foreign = { callback: "https://other.example/api/connectors/oauth/callback" };
    const forged = { state: returnState(web.state.split(".")[0]!, foreign), code: web.code, browserBinding };
    expect((await gw.api.completeConnectorOAuth(forged)).error).not.toBe("");
    // The fake token endpoint accepts the code only with the redirect_uri it was issued for.
    expect((await gw.api.completeConnectorOAuth({ ...web, browserBinding })).account?.status).toBe("connected");
    expect((await gw.api.completeConnectorOAuth({ ...web, browserBinding })).error).not.toBe("");

    const desktop = await begin(true);
    expect(returnTarget(`?state=${desktop.state}&code=x`)?.desktop).toBe(true);
    const pasted = pastedCode(desktop.state, desktop.code);
    const stranger = pastedCode(`${"z".repeat(43)}.d`, desktop.code);
    expect((await gw.api.completeConnectorOAuth({ pastedCode: stranger, browserBinding })).error).not.toBe("");
    expect((await gw.api.completeConnectorOAuth({ pastedCode: "not a code", browserBinding })).error).not.toBe("");
    expect((await gw.api.completeConnectorOAuth({ pastedCode: pasted, browserBinding })).account?.status).toBe(
      "connected",
    );
    expect((await gw.api.completeConnectorOAuth({ pastedCode: pasted, browserBinding })).error).not.toBe("");
  }, 15_000);
});
