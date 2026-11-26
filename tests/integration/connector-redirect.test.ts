import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import {
  DEFAULT_OAUTH_REDIRECT_URL,
  OAUTH_CLIENT_METADATA_REDIRECT_URL,
  OAUTH_CLIENT_METADATA_URL,
  pastedCode,
  returnState,
  returnTarget,
} from "@canopy/domain/oauth-return";
import { fakeConnector } from "./support/connector.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

const callback = "http://127.0.0.1:19112/api/connectors/oauth/callback";
const binding = "r".repeat(43);

describe.skipIf(!dockerAvailable)("connector OAuth redirect selection", () => {
  let gw: TestGateway;
  let fake: ReturnType<typeof fakeConnector>;
  const originalRedirect = process.env["CANOPY_OAUTH_REDIRECT_URL"];

  beforeAll(async () => {
    delete process.env["CANOPY_OAUTH_REDIRECT_URL"];
    fake = fakeConnector();
    gw = await startTestGateway();
  }, 60_000);

  afterAll(async () => {
    if (originalRedirect === undefined) delete process.env["CANOPY_OAUTH_REDIRECT_URL"];
    else process.env["CANOPY_OAUTH_REDIRECT_URL"] = originalRedirect;
    fake?.close();
    await gw?.close();
  });

  async function account(url = fake.url) {
    return (
      await gw.api.saveConnectorAccount({
        connectorType: "custom",
        name: "Redirect test",
        url,
        authKind: "oauth",
      })
    ).account!;
  }

  async function begin(accountId: string, desktop = false) {
    const auth = new URL(
      (
        await gw.api.beginConnectorOAuth({
          accountId,
          redirectUri: callback,
          browserBinding: binding,
          desktop,
        })
      ).authorizationUrl,
    );

    const response = await fetch(auth, { redirect: "manual" });
    expect(response.status).toBe(302);
    const back = new URL(response.headers.get("location")!);

    return { auth, state: back.searchParams.get("state")!, code: back.searchParams.get("code")! };
  }

  test("S256 DCR registers and exchanges the fixed redirect, with bound desktop and paste-code returns", async () => {
    const saved = await account();
    const { auth, state, code } = await begin(saved.id, true);
    expect(fake.registrationRedirects.at(-1)).toEqual([DEFAULT_OAUTH_REDIRECT_URL]);
    expect(auth.searchParams.get("redirect_uri")).toBe(DEFAULT_OAUTH_REDIRECT_URL);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(returnTarget(`?state=${state}&code=${code}`)).toEqual({
      desktop: true,
      url: `canopy://oauth/callback?code=${code}&state=${state}`,
    });
    const forged = returnState(state.split(".")[0]!, { callback });
    expect(
      (await gw.api.completeConnectorOAuth({ pastedCode: pastedCode(forged, code), browserBinding: binding })).error,
    ).not.toBe("");
    const request = { pastedCode: pastedCode(state, code), browserBinding: binding };
    expect((await gw.api.completeConnectorOAuth(request)).account?.status).toBe("connected");
    expect(fake.tokenRedirects.at(-1)).toBe(DEFAULT_OAUTH_REDIRECT_URL);
    expect((await gw.api.completeConnectorOAuth(request)).alreadyConnected).toBe(true);
  });

  test("CIMD-only providers authorize, exchange and refresh using the published client ID", async () => {
    const provider = fakeConnector({
      clientMetadata: { clientId: OAUTH_CLIENT_METADATA_URL, redirect: OAUTH_CLIENT_METADATA_REDIRECT_URL },
    });

    try {
      provider.duration = 1;
      const saved = await account(provider.url);
      const { auth, state, code } = await begin(saved.id);
      expect(auth.searchParams.get("client_id")).toBe(OAUTH_CLIENT_METADATA_URL);
      expect(auth.searchParams.get("redirect_uri")).toBe(OAUTH_CLIENT_METADATA_REDIRECT_URL);
      expect(returnTarget(`?state=${state}&code=${code}`)).toBeUndefined();

      const completed = await gw.api.completeConnectorOAuth({
        pastedCode: pastedCode(state, code),
        browserBinding: binding,
      });

      expect(completed.account?.status).toBe("connected");
      expect(provider.tokenRedirects).toEqual([OAUTH_CLIENT_METADATA_REDIRECT_URL]);

      provider.duration = 3600;
      expect((await gw.api.testConnector({ accountId: saved.id })).tools).toHaveLength(2);
      expect(provider.refreshes).toBe(1);

      const desktop = await begin(saved.id, true);
      expect(desktop.auth.searchParams.get("client_id")).toBe(OAUTH_CLIENT_METADATA_URL);
      expect(returnTarget(`?state=${desktop.state}&code=${desktop.code}`)?.url).toStartWith("canopy://oauth/callback?");

      expect(provider.registrations).toBe(0);
    } finally {
      await provider.close();
    }
  });

  test("DCR without advertised S256 keeps the installation callback", async () => {
    fake.codeChallengeMethods = undefined;

    try {
      const saved = await account();
      const { auth, state, code } = await begin(saved.id, true);
      expect(fake.registrationRedirects.at(-1)).toEqual([callback]);
      expect(auth.searchParams.get("redirect_uri")).toBe(callback);
      expect(returnTarget(`?state=${state}`)).toBeUndefined();
      expect((await gw.api.completeConnectorOAuth({ state, code, browserBinding: binding })).account?.status).toBe(
        "connected",
      );
      expect(fake.tokenRedirects.at(-1)).toBe(callback);
    } finally {
      fake.codeChallengeMethods = ["S256"];
    }
  });

  test("old DCR exchanges and refreshes keep their redirect; reconnect migrates once and then reuses the client", async () => {
    let saved = await account();
    process.env["CANOPY_OAUTH_REDIRECT_URL"] = callback;
    fake.duration = 1;
    let pending: Awaited<ReturnType<typeof begin>>;

    try {
      pending = await begin(saved.id);
      expect(fake.registrationRedirects.at(-1)).toEqual([callback]);
      expect(pending.auth.searchParams.get("redirect_uri")).toBe(callback);
    } finally {
      delete process.env["CANOPY_OAUTH_REDIRECT_URL"];
    }

    const registrations = fake.registrations;

    const result = await gw.api.completeConnectorOAuth({
      state: pending.state,
      code: pending.code,
      browserBinding: binding,
    });

    expect(result.account?.status).toBe("connected");
    saved = result.account!;
    expect(fake.tokenRedirects.at(-1)).toBe(callback);
    fake.duration = 3600;
    const refreshes = fake.refreshes;
    expect((await gw.api.testConnector({ accountId: saved.id })).tools).toHaveLength(2);
    expect(fake.refreshes).toBe(refreshes + 1);
    expect(fake.registrations).toBe(registrations);

    for (const expected of [registrations + 1, registrations + 1]) {
      saved = (
        await gw.api.saveConnectorAccount({
          id: saved.id,
          name: saved.name,
          url: fake.url,
          authKind: "oauth",
          replaceCredentials: true,
          expectedRevision: saved.revision,
        })
      ).account!;
      const next = await begin(saved.id);
      expect(fake.registrations).toBe(expected);
      expect(next.auth.searchParams.get("redirect_uri")).toBe(DEFAULT_OAUTH_REDIRECT_URL);
      expect(returnTarget(`?state=${next.state}&code=${next.code}`)?.url).toStartWith(`${callback}?`);

      const complete = await gw.api.completeConnectorOAuth({
        state: next.state,
        code: next.code,
        browserBinding: binding,
      });

      expect(complete.account?.status).toBe("connected");
      saved = complete.account!;
    }
  });

  test("a saved Custom MCP app only applies to the issuer that registered it", async () => {
    const registeredClient = "custom-registered-client";
    const other = fakeConnector({ clientMetadata: { clientId: registeredClient, redirect: callback } });

    try {
      const otherAccount = await account(other.url);
      await gw.api.saveConnectorOAuthApp({
        connectorType: "custom",
        issuer: new URL(other.url).origin,
        clientId: registeredClient,
      });

      const saved = await account();
      const registrations = fake.registrations;
      const refreshes = fake.refreshes;
      fake.duration = 1;
      const { auth, state, code } = await begin(saved.id, true);
      expect(auth.searchParams.get("redirect_uri")).toBe(DEFAULT_OAUTH_REDIRECT_URL);
      expect(fake.registrations).toBe(registrations + 1);
      expect((await gw.api.completeConnectorOAuth({ state, code, browserBinding: binding })).account?.status).toBe(
        "connected",
      );

      fake.duration = 3600;
      expect((await gw.api.testConnector({ accountId: saved.id })).tools).toHaveLength(2);
      expect(fake.refreshes).toBe(refreshes + 1);

      const matching = await begin(otherAccount.id, true);
      expect(matching.auth.searchParams.get("client_id")).toBe(registeredClient);
      expect(
        (
          await gw.api.completeConnectorOAuth({
            state: matching.state,
            code: matching.code,
            browserBinding: binding,
          })
        ).account?.status,
      ).toBe("connected");
      expect(other.registrations).toBe(0);
    } finally {
      fake.duration = 3600;
      await other.close();
    }
  });
});
