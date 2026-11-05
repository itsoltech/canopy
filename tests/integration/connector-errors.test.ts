import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore } from "@canopy/gateway/store";
import { toJson } from "@bufbuild/protobuf";
import { connectors } from "@canopy/contracts";
import { fakeConnector } from "./support/connector.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("connector test diagnostics at the gateway boundary", () => {
  let gw: TestGateway;
  let fake: ReturnType<typeof fakeConnector>;

  let reply: (
    method: string,
    id: number | undefined,
    request: Request,
  ) => Response | undefined | Promise<Response | undefined>;

  const privateHeader = `private-header-${crypto.randomUUID()}`;

  beforeAll(async () => {
    reply = () => undefined;
    fake = fakeConnector({ response: (...args) => reply(...args) });
    gw = await startTestGateway();
  }, 60_000);

  afterAll(async () => {
    fake?.close();
    await gw?.close();
  });

  const stored = (id: string) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return (yield* sql<{
          error: { kind: string; message: string; detail: string } | null;
        }>`SELECT error FROM connector_accounts WHERE id=${id}::uuid`)[0]!.error;
      }),
    );

  const cases = [
    { status: 401, message: "Slack rejected the token (401). Reconnect the account." },
    {
      status: 403,
      message:
        "Slack denied access to this app (403). Check the app's installation, approval and distribution settings.",
    },
    { status: 404, message: "The server endpoint was not found (404). Check the endpoint, then reconnect." },
    { status: 429, message: "The server received too many requests (429). Wait, then test again." },
    { status: 503, message: "The server is unavailable (503). Test again later." },
  ];

  for (const item of cases) {
    test(`HTTP ${item.status}: safe persisted diagnosis, one warning, recovery and owner scoping`, async () => {
      const account = (
        await gw.api.saveConnectorAccount({
          connectorType: "slack",
          name: "work",
          url: fake.url,
          authKind: "oauth",
        })
      ).account!;

      // Set gateway-owned credentials, as a completed user OAuth exchange would.
      await gw.core.connectors.run((s) =>
        s
          .owned(gw.userId, account.id)
          .pipe(
            Effect.flatMap((row) =>
              s.updateCredentials(
                row,
                { tokens: { access_token: fake.secret, token_type: "user" }, headers: { "X-Private": privateHeader } },
                "connected",
              ),
            ),
          ),
      );
      reply = (method) =>
        method === "initialize"
          ? Response.json(
              {
                error: {
                  code: "app_not_allowed",
                  message: `App denied ${fake.secret} ${privateHeader} https://example.com/?secret=unrecognized-value\nfor this workspace`,
                },
                headers: { authorization: `Bearer ${fake.secret}` },
              },
              { status: item.status },
            )
          : undefined;
      const warnings = spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const result = await gw.api.testConnector({ accountId: account.id });
        expect(result.account!.error!.message).toBe(item.message);
        const listed = (await gw.api.listConnectors({})).accounts.find((a) => a.id === account.id)!;
        expect(listed.status).toBe("error");
        expect(listed.error).toMatchObject({ kind: "http", message: item.message });
        expect(listed.error!.detail).toContain(`HTTP status: ${item.status}`);
        expect(listed.error!.detail).toContain("Phase: initialize");
        expect(listed.error!.detail).toContain("Code: app_not_allowed");
        expect(listed.error!.detail).toContain("[REDACTED]");
        expect(listed.error!.detail).toContain("for this workspace");
        expect(await stored(account.id)).toMatchObject({
          kind: "http",
          message: item.message,
          detail: listed.error!.detail,
        });
        expect(warnings.mock.calls).toHaveLength(1);

        const output = JSON.stringify([
          toJson(connectors.ConnectorAccountSchema, listed),
          await stored(account.id),
          warnings.mock.calls,
        ]);

        for (const secret of [fake.secret, privateHeader, "unrecognized-value", "authorization"])
          expect(output).not.toContain(secret);
        expect(warnings.mock.calls[0]![0]).not.toContain("\n");

        const other = await gw.runtime.runPromise(
          GatewayStore.use((s) => s.ensureUser(`other-${account.id}@test.local`, "Other")),
        );

        expect(await gw.core.connectors.run((s) => s.list(other))).toHaveLength(0);
        await expect(gw.core.connectors.run((s) => s.owned(other, account.id))).rejects.toThrow();
        reply = () => undefined;
        const recovered = await gw.api.testConnector({ accountId: account.id });
        expect(recovered.tools).toHaveLength(2);
        expect(recovered.account!.status).toBe("connected");
        expect(recovered.account!.error).toBeUndefined();
        expect(await stored(account.id)).toBeNull();
      } finally {
        warnings.mockRestore();
        reply = () => undefined;
      }
    });
  }

  test("OAuth body and JSON-RPC errors retain their phase and safe server code/message", async () => {
    const account = (
      await gw.api.saveConnectorAccount({ connectorType: "custom", name: "errors", url: fake.url, token: fake.secret })
    ).account!;

    const cases = [
      {
        kind: "oauth",
        code: "invalid_token",
        message: "Custom MCP server could not authorize the account. Reconnect the account.",
        response: () =>
          Response.json(
            { error: "invalid_token", error_description: `Expired ${fake.secret} ${privateHeader}` },
            { status: 400 },
          ),
      },
      {
        kind: "protocol",
        code: "-32603",
        message: "The server sent an unexpected response. Check the endpoint, then test again.",
        response: (id?: number) =>
          Response.json({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: `Catalog unavailable ${fake.secret} ${privateHeader}`,
              data: { token: fake.secret },
            },
          }),
      },
    ];

    const warnings = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      for (const item of cases) {
        reply = (method, id) => (method === "tools/list" ? item.response(id) : undefined);
        // Include a second secret header, and verify it cannot be echoed into diagnostics.
        const current = (await gw.api.listConnectors({})).accounts.find((a) => a.id === account.id)!;
        await gw.api.saveConnectorAccount({
          id: account.id,
          name: account.name,
          expectedRevision: current.revision,
          token: fake.secret,
          headers: { "X-Private": privateHeader },
        });
        expect((await gw.api.testConnector({ accountId: account.id })).account!.error!.message).toBe(item.message);
        const error = (await stored(account.id))!;
        expect(error).toMatchObject({ kind: item.kind, message: item.message });
        expect(error.detail).toContain("Phase: tools/list");
        expect(error.detail).toContain(`Code: ${item.code}`);
        expect(error.detail).toContain("[REDACTED]");

        for (const secret of [fake.secret, privateHeader])
          expect(JSON.stringify([error, warnings.mock.calls])).not.toContain(secret);
      }

      expect(warnings.mock.calls).toHaveLength(2);
      await gw.api.disconnectConnector({ accountId: account.id });
      expect(await stored(account.id)).toBeNull();
    } finally {
      warnings.mockRestore();
      reply = () => undefined;
    }
  }, 25_000);

  test("automatic scoped listing retries error accounts even with a cached catalog", async () => {
    const workerId = gw.workerId;

    const saved = (
      await gw.api.saveConnectorAccount({ connectorType: "custom", name: "recover", url: fake.url, token: fake.secret })
    ).account!;

    await gw.api.setConnectorAccess({ accountId: saved.id, expectedRevision: saved.revision, workerIds: [workerId] });
    const before = await gw.api.testConnector({ accountId: saved.id });
    expect(before.tools).toHaveLength(2);
    const warnings = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      reply = (method) => (method === "tools/list" ? new Response(null, { status: 503 }) : undefined);
      expect((await gw.api.testConnector({ accountId: saved.id })).account!.status).toBe("error");
      expect(
        (await gw.core.connectors.tools(gw.userId, { workerId })).filter((t) => t.accountId === saved.id),
      ).toHaveLength(0);
      expect(await stored(saved.id)).toMatchObject({ kind: "http" });
      reply = () => undefined;
      const recovered = await gw.core.connectors.tools(gw.userId, { workerId });
      expect(recovered.filter((t) => t.accountId === saved.id)).toEqual(before.tools);
      const account = (await gw.api.listConnectors({})).accounts.find((a) => a.id === saved.id)!;
      expect(account.status).toBe("connected");
      expect(account.error).toBeUndefined();
      expect(await stored(saved.id)).toBeNull();
      await gw.api.disconnectConnector({ accountId: saved.id });
      expect((await gw.core.connectors.tools(gw.userId, { workerId })).some((t) => t.accountId === saved.id)).toBe(
        false,
      );
    } finally {
      reply = () => undefined;
      warnings.mockRestore();
    }
  });

  test("Slack's disabled MCP app error gives a specific action without exposing the settings URL", async () => {
    const account = (
      await gw.api.saveConnectorAccount({
        connectorType: "slack",
        name: "MCP access",
        url: fake.url,
        authKind: "oauth",
      })
    ).account!;

    await gw.core.connectors.run((s) =>
      s
        .owned(gw.userId, account.id)
        .pipe(
          Effect.flatMap((row) =>
            s.updateCredentials(row, { tokens: { access_token: fake.secret, token_type: "user" } }, "connected"),
          ),
        ),
    );
    const warnings = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      reply = (method, id) =>
        method === "initialize"
          ? Response.json(
              {
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32600,
                  message: `App is not enabled for Slack MCP server access. Please enable it here: https://api.slack.com/apps/private-app-id/settings?token=${fake.secret}`,
                },
              },
              { status: 400 },
            )
          : undefined;
      const result = await gw.api.testConnector({ accountId: account.id });
      expect(result.account?.error?.message).toBe(
        "Slack MCP access is off for this app. Turn it on in the app's settings, then test again.",
      );
      expect(result.account?.error?.detail).toContain("HTTP status: 400");
      expect(result.account?.error?.detail).toContain("Code: -32600");
      expect(result.account?.error?.detail).toContain("[endpoint]");

      const output = JSON.stringify([
        toJson(connectors.TestConnectorResponseSchema, result),
        await stored(account.id),
        warnings.mock.calls,
      ]);

      for (const secret of [fake.secret, "private-app-id", "https://api.slack.com"])
        expect(output.includes(secret)).toBe(false);
      reply = () => undefined;
      expect((await gw.api.testConnector({ accountId: account.id })).account?.status).toBe("connected");
    } finally {
      warnings.mockRestore();
      reply = () => undefined;
    }
  });

  test("timeout while listing tools is distinguished from a network failure", async () => {
    const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
    let release: (() => void) | undefined;

    try {
      const account = (
        await gw.api.saveConnectorAccount({
          connectorType: "custom",
          name: "timeout",
          url: fake.url,
          token: fake.secret,
        })
      ).account!;

      reply = async (method) => {
        if (method !== "tools/list") return undefined;
        await new Promise<void>((resolve) => {
          release = resolve;
        });

        return new Response(null, { status: 503 });
      };

      expect(
        (await gw.api.testConnector({ accountId: account.id }, { timeoutMs: 25_000 })).account!.error!.message,
      ).toBe("The server took too long to respond. Test again.");
      expect(await stored(account.id)).toMatchObject({ kind: "timeout", detail: "Phase: tools/list; Class: timeout" });
      release?.();
      reply = () => undefined;

      const unavailable = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const url = unavailable.url.toString();
      unavailable.stop(true);

      const network = (
        await gw.api.saveConnectorAccount({ connectorType: "custom", name: "network", url, token: fake.secret })
      ).account!;

      expect((await gw.api.testConnector({ accountId: network.id })).account!.error!.message).toBe(
        "Couldn't reach the server. Check your connection, then test again.",
      );
      expect(await stored(network.id)).toMatchObject({ kind: "network" });
      expect(warnings.mock.calls).toHaveLength(2);
      expect(JSON.stringify(warnings.mock.calls)).not.toContain(fake.secret);
    } finally {
      release?.();
      reply = () => undefined;
      warnings.mockRestore();
    }
  }, 30_000);

  test("Slack's documented top-level user OAuth token authenticates Streamable HTTP", async () => {
    const observed: { bearer: boolean; accept: string; protocol: string | null }[] = [];

    const slack = fakeConnector({
      userToken: true,
      response: (method, _id, request) => {
        if (method === "initialize" || method === "tools/list")
          observed.push({
            bearer: request.headers.get("authorization")?.startsWith("Bearer xoxp-") === true,
            accept: request.headers.get("accept") ?? "",
            protocol: request.headers.get("mcp-protocol-version"),
          });

        return undefined;
      },
    });

    try {
      const callback = "http://127.0.0.1:19112/api/connectors/oauth/callback";
      const redirect = "https://itsoltech.github.io/canopy/oauth/callback";
      const app = slack.registeredApp(redirect);
      await gw.api.saveConnectorOAuthApp({ connectorType: "slack", issuer: slack.issuer, ...app });

      const account = (
        await gw.api.saveConnectorAccount({
          connectorType: "slack",
          name: "user OAuth",
          url: slack.url,
          authKind: "oauth",
        })
      ).account!;

      const binding = "s".repeat(43);

      const auth = new URL(
        (
          await gw.api.beginConnectorOAuth({
            accountId: account.id,
            redirectUri: callback,
            browserBinding: binding,
            scope: "tools",
          })
        ).authorizationUrl,
      );

      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect(auth.searchParams.get("redirect_uri")).toBe(redirect);
      const back = new URL((await fetch(auth, { redirect: "manual" })).headers.get("location")!);

      const complete = await gw.api.completeConnectorOAuth({
        state: back.searchParams.get("state")!,
        code: back.searchParams.get("code")!,
        browserBinding: binding,
      });

      expect(complete.error).toBe("");
      expect(complete.account!.status).toBe("connected");
      expect((await gw.api.testConnector({ accountId: account.id })).tools).toHaveLength(2);
      expect(observed).toHaveLength(2);
      expect(
        observed.every(
          (r) => r.bearer && r.accept.includes("application/json") && r.accept.includes("text/event-stream"),
        ),
      ).toBe(true);
      expect(observed[1]!.protocol).toBe("2025-03-26");

      for (const token of slack.tokens)
        expect(
          JSON.stringify([
            toJson(connectors.CompleteConnectorOAuthResponseSchema, complete),
            toJson(connectors.ListConnectorsResponseSchema, await gw.api.listConnectors({})),
          ]),
        ).not.toContain(token);
    } finally {
      slack.close();
    }
  });
});
