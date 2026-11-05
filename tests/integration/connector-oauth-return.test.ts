import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { pastedCode } from "@canopy/domain/oauth-return";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore } from "@canopy/gateway/store";
import { fakeConnector } from "./support/connector.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("connector OAuth returns", () => {
  let gw: TestGateway;
  let fake: ReturnType<typeof fakeConnector>;
  let rejectExchange = false;
  let exchangeStatus = 400;
  let echoedVerifier = "";
  const binding = "d".repeat(43);

  beforeAll(async () => {
    fake = fakeConnector({
      exchangeResponse: async (request) => {
        if (!rejectExchange) return undefined;
        const params = new URLSearchParams(await request.text());
        echoedVerifier = params.get("code_verifier")!;

        return Response.json(
          {
            error: "invalid_grant",
            error_description: `App approval required ${params.get("code")} ${params.get("code_verifier")} ${params.get("client_secret")} https://example.com/?secret=hidden-value\nfor this workspace`,
          },
          { status: exchangeStatus },
        );
      },
    });
    gw = await startTestGateway();
  }, 60_000);

  afterAll(async () => {
    fake?.close();
    await gw?.close();
  });

  async function begin(desktop = true, connectorType = "custom") {
    const account = (
      await gw.api.saveConnectorAccount({
        connectorType,
        name: "OAuth return",
        url: fake.url,
        authKind: "oauth",
      })
    ).account!;

    const start = await gw.api.beginConnectorOAuth({
      accountId: account.id,
      browserBinding: binding,
      redirectUri: "http://127.0.0.1:19112/api/connectors/oauth/callback",
      desktop,
    });

    const back = new URL((await fetch(start.authorizationUrl, { redirect: "manual" })).headers.get("location")!);

    return {
      account,
      state: back.searchParams.get("state")!,
      code: back.searchParams.get("code")!,
      pastedCode: pastedCode(back.searchParams.get("state")!, back.searchParams.get("code")!),
    };
  }

  test("pasting after desktop completion reports the connected account without another exchange", async () => {
    const pending = await begin();
    const first = await gw.api.completeConnectorOAuth({ ...pending, pastedCode: "", browserBinding: binding });
    expect(first.account?.status).toBe("connected");
    const exchanges = fake.tokenRedirects.length;
    const replay = await gw.api.completeConnectorOAuth({ pastedCode: pending.pastedCode, browserBinding: binding });
    expect(replay.error).toBe("");
    expect(replay.alreadyConnected).toBe(true);
    expect(replay.account?.id === pending.account.id).toBe(true);
    expect(fake.tokenRedirects.length).toBe(exchanges);
  });

  for (const desktop of [true, false]) {
    test(`the exact Pages code and copied URL work for ${desktop ? "desktop" : "web"}`, async () => {
      for (const format of ["code", "url", "query"] as const) {
        const pending = await begin(desktop);
        const query = new URLSearchParams({ state: pending.state, code: pending.code }).toString();

        const text = {
          code: ` ${pending.pastedCode} `,
          url: `https://itsoltech.github.io/canopy/oauth/callback?${query}`,
          query,
        }[format];

        const result = await gw.api.completeConnectorOAuth({ pastedCode: text, browserBinding: binding });
        expect(result.error).toBe("");
        expect(result.account?.status).toBe("connected");
        expect(result.alreadyConnected).toBe(false);
      }
    });
  }

  test("another binding, a missing cookie and a restarted desktop binding never claim the state", async () => {
    const pending = await begin();

    for (const other of ["w".repeat(43), "", "restart".repeat(8)]) {
      const result = await gw.api.completeConnectorOAuth({ pastedCode: pending.pastedCode, browserBinding: other });
      expect(result.failure?.kind).toBe("oauth_binding");
      expect(result.error).toContain("Use the window that started sign-in");
      expect(result.account).toBeUndefined();
    }

    const otherUser = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("other-oauth@test.local", "Other")),
    );

    await expect(gw.core.connectors.run((s) => s.consumeState(otherUser, pending.state, binding))).rejects.toThrow();
    expect(
      (await gw.api.completeConnectorOAuth({ pastedCode: pending.pastedCode, browserBinding: binding })).account
        ?.status,
    ).toBe("connected");

    const replay = await gw.api.completeConnectorOAuth({
      pastedCode: pending.pastedCode,
      browserBinding: "w".repeat(43),
    });

    expect(replay.failure?.kind).toBe("oauth_binding");
    expect(replay.account).toBeUndefined();
  });

  test("expiry uses the database clock, including completed receipts", async () => {
    for (const complete of [false, true]) {
      const pending = await begin();

      if (complete) await gw.api.completeConnectorOAuth({ pastedCode: pending.pastedCode, browserBinding: binding });
      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE connector_oauth_states SET expires_at=now()-interval '1 second' WHERE account_id=${pending.account.id}::uuid`;
        }),
      );
      const result = await gw.api.completeConnectorOAuth({ pastedCode: pending.pastedCode, browserBinding: binding });
      expect(result.failure?.kind).toBe("oauth_expired");
      expect(result.error).toBe("This code expired. Start sign-in again.");
      expect(result.account).toBeUndefined();
    }
  });

  test("malformed and truncated codes do not claim a valid sign-in", async () => {
    const pending = await begin();

    for (const text of [
      "not a code!",
      pending.pastedCode.slice(0, 20),
      "https://example.com/oauth/callback",
      "?code=value&state=bad",
    ]) {
      const result = await gw.api.completeConnectorOAuth({ pastedCode: text, browserBinding: binding });
      expect(result.failure?.kind).toBe("oauth_malformed");
      expect(result.error).toBe("This is not a sign-in code. Copy the code from the sign-in page.");
    }

    expect(
      (await gw.api.completeConnectorOAuth({ pastedCode: pending.pastedCode, browserBinding: binding })).error,
    ).toBe("");
  });

  test("Slack exchange rejections preserve their redacted reason, and a failed exchange is never success", async () => {
    const app = fake.registeredApp("https://itsoltech.github.io/canopy/oauth/callback");
    await gw.api.saveConnectorOAuthApp({ connectorType: "slack", issuer: fake.issuer, ...app });
    const pending = await begin(true, "slack");
    rejectExchange = true;

    try {
      const result = await gw.api.completeConnectorOAuth({ pastedCode: pending.pastedCode, browserBinding: binding });
      expect(result.failure?.kind).toBe("oauth");
      expect(result.error).toBe("Slack rejected sign-in. Check the app settings, then start sign-in again.");
      expect(result.failure?.detail).toContain("Phase: oauth/token");
      expect(result.failure?.detail).toContain("Code: invalid_grant");
      expect(result.failure?.detail).toContain("App approval required");
      expect(result.failure?.detail).toContain("for this workspace");

      expect(echoedVerifier.length).toBeGreaterThan(0);

      for (const secret of [pending.code, pending.state, app.clientSecret, echoedVerifier, "hidden-value"])
        expect(JSON.stringify(result).includes(secret)).toBe(false);
      expect(result.failure?.detail).toContain("[REDACTED]");
      expect(result.account).toBeUndefined();
      const replay = await gw.api.completeConnectorOAuth({ pastedCode: pending.pastedCode, browserBinding: binding });
      expect(replay.failure?.kind).toBe("oauth_used");
      expect(replay.error).toBe("This code was already used. Start sign-in again.");
      expect(replay.account).toBeUndefined();
    } finally {
      rejectExchange = false;
    }
  });

  test("a failed exchange for an already-connected account never becomes a successful replay", async () => {
    const pending = await begin();
    await gw.api.completeConnectorOAuth({ pastedCode: pending.pastedCode, browserBinding: binding });

    const start = await gw.api.beginConnectorOAuth({
      accountId: pending.account.id,
      browserBinding: binding,
      redirectUri: "http://127.0.0.1:19112/api/connectors/oauth/callback",
      desktop: true,
    });

    const back = new URL((await fetch(start.authorizationUrl, { redirect: "manual" })).headers.get("location")!);
    const code = pastedCode(back.searchParams.get("state")!, back.searchParams.get("code")!);
    rejectExchange = true;

    try {
      expect((await gw.api.completeConnectorOAuth({ pastedCode: code, browserBinding: binding })).failure?.kind).toBe(
        "oauth",
      );
      const replay = await gw.api.completeConnectorOAuth({ pastedCode: code, browserBinding: binding });
      expect(replay.failure?.kind).toBe("oauth_used");
      expect(replay.alreadyConnected).toBe(false);
      expect(replay.account).toBeUndefined();
      const accounts = (await gw.api.listConnectors({})).accounts;
      expect(accounts.find((account) => account.id === pending.account.id)?.status).toBe("connected");
    } finally {
      rejectExchange = false;
    }
  });

  test("a Slack HTTP 200 error envelope is a provider rejection", async () => {
    const pending = await begin(true, "slack");
    rejectExchange = true;
    exchangeStatus = 200;

    try {
      const result = await gw.api.completeConnectorOAuth({ pastedCode: pending.pastedCode, browserBinding: binding });
      expect(result.failure?.kind).toBe("oauth");
      expect(result.failure?.detail).toContain("Code: invalid_grant");
      expect(result.account).toBeUndefined();
    } finally {
      rejectExchange = false;
      exchangeStatus = 400;
    }
  });
});
