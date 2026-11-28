import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { serviceTokenAuth, uiRoutes } from "@canopy/gateway/api";
import { startGrpcServer } from "@canopy/transport";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Cause, Effect, Exit } from "effect";
import { constraintOf } from "../../apps/gateway/src/api/ui-errors.ts";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { githubFixture } from "./support/github.ts";
import { SERVICE_TOKEN, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("GitHub owner, device and PAT boundaries", () => {
  let gw: TestGateway;
  let fixture: ReturnType<typeof githubFixture>;
  const browser = { headers: { "canopy-github-client": randomBytes(32).toString("base64url") } };
  beforeAll(async () => {
    fixture = githubFixture();
    gw = await startTestGateway({ github: fixture.options });
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture?.close();
  });

  test("two owners use gRPC against the same real store, including attempt and catalogue isolation", async () => {
    fixture.mode("success");
    const attempt = (await gw.api.beginGitHubDeviceAuth({ clientRequestId: crypto.randomUUID() }, browser)).attempt!;
    fixture.advance(5000);
    await gw.core.github.device.tick();
    const account = (await gw.api.getGitHubDeviceAuth({ attemptId: attempt.id }, browser)).attempt!.accountId;

    const user = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("second@example.test", "Second owner")),
    );

    const core = new GatewayCore({
      runtime: gw.runtime,
      userId: user,
      instanceId: "other-owner",
      sshSecretsKey: gw.secretsKey,
      github: fixture.options,
    });

    const grpc = await startGrpcServer({
      routes: uiRoutes(core),
      interceptors: [serviceTokenAuth(SERVICE_TOKEN)],
      host: "127.0.0.1",
      port: 0,
    });

    const foreign = createClient(
      ui.GatewayService,
      createGrpcTransport({
        baseUrl: grpc.url,
        interceptors: [
          (next) => (request) => {
            request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

            return next(request);
          },
        ],
      }),
    );

    try {
      expect((await foreign.listGitHubAccounts({})).accounts).toHaveLength(0);

      for (const operation of [
        () => foreign.getGitHubDeviceAuth({ attemptId: attempt.id }, browser),
        () => foreign.cancelGitHubDeviceAuth({ attemptId: attempt.id }, browser),
        () => foreign.disconnectGitHubAccount({ accountId: account }),
        () => foreign.listGitHubInstallations({ accountId: account }),
        () =>
          foreign.getGitHubAgentAccess({ accountId: account, repositoryName: "itsoltech/canopy", repositoryId: "777" }),
        () =>
          foreign.setGitHubAgentAccess({ accountId: account, repositoryName: "itsoltech/canopy", repositoryId: "777" }),
        () => foreign.listGitHubRepositories({ accountId: account, installationId: "101" }),
      ])
        expect(
          await operation().then(
            () => 0,
            (e) => ConnectError.from(e).code,
          ),
        ).toBe(Code.NotFound);
      expect((await gw.api.listGitHubAccounts({})).accounts[0]!.status).toBe("connected");
    } finally {
      await core.stopSweep();
      await grpc.close();
    }
  });

  test("only an explicitly selected owned official GitHub PAT is eligible; changing the connector invalidates it", async () => {
    const token = fixture.pat(202);

    const account = (
      await gw.api.saveConnectorAccount({ connectorType: "github", name: "Work PAT", authKind: "headers", token })
    ).account!;

    expect((await gw.api.listGitHubAccounts({})).patCandidates.map((p) => p.connectorAccountId)).toContain(account.id);
    expect((await gw.api.listGitHubAccounts({})).accounts.some((a) => a.authKind === "pat")).toBe(false);
    const selected = (await gw.api.useGitHubPat({ connectorAccountId: account.id })).account!;
    expect(selected).toMatchObject({ login: "account-202", authKind: "pat", connectorAccountId: account.id });
    const stored = await gw.core.github.run((s) => s.owned(gw.userId, selected.id));
    expect(stored.credentials).toBeNull();
    expect(stored.connector_revision).toBe(account.revision);

    const custom = (
      await gw.api.saveConnectorAccount({
        connectorType: "custom",
        name: "Custom",
        url: "https://example.test/mcp",
        authKind: "headers",
        token,
      })
    ).account!;

    expect(await failure(gw.api.useGitHubPat({ connectorAccountId: custom.id }))).toContain(
      "Choose a GitHub personal access token",
    );
    await gw.api.disconnectConnector({ accountId: account.id });
    expect((await gw.api.listGitHubAccounts({})).accounts.find((a) => a.id === selected.id)!.status).toBe(
      "needs_reconnect",
    );
    expect(await failure(gw.core.github.access.get(selected.id, "/user"))).toContain("Reconnect");
  });

  test("removing a PAT retires repository grants created while the same GitHub user used the App", async () => {
    const device = (await gw.api.listGitHubAccounts({})).accounts.find((a) => a.githubUserId === "101")!;
    const repo = { accountId: device.id, repositoryId: "1010", repositoryName: "organization-101/canopy" };
    const project = (await gw.api.createProject({ name: "Retired agent grant" })).project!.id;
    const access = await gw.api.setGitHubAgentAccess({ ...repo, projectIds: [project] });

    const [native] = await gw.core.connectors.run((s) =>
      s.list(gw.userId, { projectId: project, connectorType: "github_repository" }),
    );

    expect(native).toBeDefined();

    const pat = (
      await gw.api.saveConnectorAccount({
        connectorType: "github",
        name: "PAT replacing the App",
        token: fixture.pat(101),
      })
    ).account!;

    expect((await gw.api.useGitHubPat({ connectorAccountId: pat.id })).account?.id).toBe(device.id);
    expect(await failure(gw.core.github.agentBinding(native!.id, access.revision))).toContain("unavailable");
    await gw.core.github.run((store) => store.setUpdateAccount(gw.userId, device.id, false));
    await gw.api.deleteConnectorAccount({ accountId: pat.id });
    expect((await gw.api.listGitHubAccounts({})).accounts.some((a) => a.id === device.id)).toBe(false);
    expect(await gw.core.github.run((store) => store.updateAccount(gw.userId))).toMatchObject({
      account_id: null,
      enabled: false,
    });
    expect(
      await gw.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) => sql`SELECT account_id FROM connector_project_grants WHERE account_id=${native!.id}::uuid`,
        ),
      ),
    ).toEqual([]);
  });

  test("a linked connector alias cannot change which GitHub user a local PAT authenticates", async () => {
    const connector = async (user: number) =>
      (
        await gw.api.saveConnectorAccount({
          connectorType: "github",
          name: `PAT ${user}`,
          authKind: "headers",
          token: fixture.pat(user),
        })
      ).account!;

    const selected = await connector(301);
    const other = await connector(302);
    const account = (await gw.api.useGitHubPat({ connectorAccountId: selected.id })).account!;
    await gw.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql`WITH shared AS (
        INSERT INTO config_items(owner_user_id,kind,global_id,local_id,revision)
        VALUES (${gw.userId}::uuid,'connector',${other.id},${other.id},1) ON CONFLICT DO NOTHING
      ) INSERT INTO config_aliases(owner_user_id,kind,alias_id,global_id)
        VALUES (${gw.userId}::uuid,'connector',${selected.id},${other.id})`,
      ),
    );

    expect((await gw.core.github.access.get(account.id, "/user")).value).toMatchObject({ id: 301 });
    expect((await gw.api.useGitHubPat({ connectorAccountId: selected.id })).account?.login).toBe("account-301");
  });

  test("paired native clients bind attempts to their authenticated device, ignoring browser headers and payload bindings", async () => {
    const network = new NetworkAccess({
      store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
      host: "127.0.0.1",
    });

    gw.core.network = network;
    const unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
    const transport = nodePinnedTransport();

    const native = (token?: string) =>
      routedMobileClient({ connection: gw.core.mobile.networkRoutes(), ...(token && { token }), transport });

    try {
      const pairing = await gw.api.createMobilePairing({});

      const paired = await native().pairing.exchangeMobilePairing({
        code: pairing.code,
        name: "Phone",
        platform: "ios",
      });

      const api = native(paired.deviceToken).api;

      const started = await api.beginGitHubDeviceAuth({
        clientRequestId: crypto.randomUUID(),
        clientBinding: "a".repeat(64),
      });

      expect(started.attempt!.state).toBe("pending");
      expect(
        await failure(
          gw.api.getGitHubDeviceAuth({ attemptId: started.attempt!.id, clientBinding: "a".repeat(64) }, browser),
        ),
      ).toContain("not found");
      expect((await api.cancelGitHubDeviceAuth({ attemptId: started.attempt!.id })).attempt!.state).toBe("cancelled");
      await gw.api.revokeMobileDevice({ id: paired.device!.id });
      expect(await failure(api.listGitHubAccounts({}))).toContain("Invalid or revoked");
    } finally {
      unmount();
      await network.close();
    }
  });

  test("database rejects a cross-owner PAT reference even if an internal caller bypasses RPC checks", async () => {
    const connector = (await gw.api.listConnectors({})).accounts[0]!;

    const other = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("third@example.test", "Third owner")),
    );

    const rejected = await gw.runtime.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO github_accounts(id,owner_user_id,github_user_id,login,auth_kind,connector_account_id,connector_revision,status)
        VALUES (${crypto.randomUUID()}::uuid,${other}::uuid,'203','foreign','pat',${connector.id}::uuid,1,'connected')`;
        }),
      ),
    );

    expect(Exit.isFailure(rejected) && constraintOf(Cause.squash(rejected.cause))).toBe(
      "github_accounts_connector_owner",
    );
  });
});
