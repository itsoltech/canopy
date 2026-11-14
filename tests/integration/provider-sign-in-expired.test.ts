import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { REJECTED_LOGIN_DETAIL } from "@canopy/domain/provider-accounts";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { journalHello, openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

/**
 * `codex login status` says "Logged in" while the refresh token is expired; only a turn finds out. The rejected turn
 * marks the account on the gateway, and a new sign-in or a successful turn clears it.
 */
describe.skipIf(!dockerAvailable)("expired provider sign-in over the gateway↔worker link", () => {
  const dir = tempDir("canopy-sign-in-expired-");
  const deviceCodex = join(dir, "device-codex");
  const executable = resolve(import.meta.dir, "fixtures/login-codex.ts");
  let gw: TestGateway;
  let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
  let host: WorkerHost;
  let link: GatewayLink;
  let workerId = "";
  let threadId = "";

  const providersAccount = async () =>
    (await gw.api.listProviderInstances({})).instances
      .find((i) => i.harness === Provider.CODEX && i.id === "native")
      ?.workers.find((w) => w.workerId === workerId)?.account;

  const overviewAccount = async () =>
    (await gw.api.getOverview({})).workers
      .find((w) => w.id === workerId)
      ?.providerInstances.find((i) => i.harness === Provider.CODEX && i.id === "native")?.account;

  const lastTurn = async () => (await gw.api.getThread({ threadId })).thread?.status;

  const sql = <A extends object>(run: (sql: SqlClient.SqlClient) => Effect.Effect<readonly A[], unknown>) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, run));

  const completedTurns = async () =>
    (
      await sql<{ n: number }>(
        (s) => s`SELECT count(*)::int AS n FROM turns WHERE thread_id = ${threadId}::uuid AND status = 'completed'`,
      )
    )[0]?.n ?? 0;

  async function send(text: string) {
    await eventually(lastTurn, (status) => status === "idle", 15_000);
    await gw.api.sendMessage({ threadId, text, clientRequestId: crypto.randomUUID() });
  }

  beforeAll(async () => {
    mkdirSync(join(dir, "data"));
    mkdirSync(deviceCodex);
    // The device's Codex login: a fixture token whose refresh token has expired.
    writeFileSync(join(deviceCodex, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-expired" } }));
    gw = await startTestGateway();
    const worker = await gw.addWorker("sign-in-worker");
    workerId = worker.workerId;
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          workerId,
          {
            codex: { enabled: true, executablePath: executable },
            claude: { enabled: false },
            grok: { enabled: false },
          },
          gw.userId,
        ),
      ),
    );
    runtime = ManagedRuntime.make(Journal.layer(join(dir, "data/journal.db")));
    host = new WorkerHost({
      runtime,
      dataDir: join(dir, "data"),
      clientVersion: "test",
      deviceHomes: { claude: join(dir, "device-claude"), codex: deviceCodex, grok: join(dir, "device-grok") },
    });
    link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: worker.credential,
      hello: {
        workerId,
        host: { os: process.platform },
        capabilities: ["provider_account_status", "probe_providers", "codex_device_login", "codex_device_login_linked"],
        ...(await runtime.runPromise(journalHello())),
      },
    });
    void serveLink(link, host, runtime);
    await eventually(providersAccount, (a) => a?.state === "signed_in", 20_000);

    const projectId = (await gw.api.createProject({ name: "Sign-in" })).project!.id;
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;
    threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Expired login" }))
      .thread!.id;
  }, 60_000);

  afterAll(async () => {
    link?.close();
    await host?.close();
    await runtime?.dispose();
    await gw?.close();
  });

  test("a rejected turn shows the account as expired until the device login signs in again", async () => {
    // The CLI alone cannot tell: it reports a ChatGPT login.
    expect(await providersAccount()).toMatchObject({ state: "signed_in", authMethod: "ChatGPT", loginRevision: "" });

    await send("Keep working");
    const expired = await eventually(providersAccount, (a) => a?.state === "expired", 20_000);
    expect(expired).toMatchObject({ state: "expired", authMethod: "ChatGPT", detail: REJECTED_LOGIN_DETAIL });
    expect(expired?.loginRevision).toBe("");
    expect((await overviewAccount())?.state).toBe("expired");
    const turns = (await gw.api.getThread({ threadId })).thread;
    expect(turns?.status).not.toBe("running");

    // Checking the CLI again does not hide the rejection: the login file is the same.
    await gw.api.refreshProviders({ workerId, harness: Provider.CODEX, id: "native", accountOnly: true });
    expect((await providersAccount())?.state).toBe("expired");

    // The built-in instance uses the device login: the app signs the device's Codex in again.
    // Repeated clicks share one sign-in; the account reports that sign-in's outcome, not just a newer check.
    const start = () => gw.api.startProviderLogin({ harness: Provider.CODEX, id: "native", workerId });
    const [login, again] = await Promise.all([start(), start()]);
    expect(login.userCode).toBe("ABCD-1234");
    expect(login.loginId).not.toBe("");
    expect(again.loginId).toBe(login.loginId);
    expect(
      await eventually(providersAccount, (a) => a?.state === "signed_in" && a.loginOutcome === "signed_in", 20_000),
    ).toMatchObject({ state: "signed_in", detail: "", loginId: login.loginId, loginOutcome: "signed_in" });
    expect((await overviewAccount())?.state).toBe("signed_in");

    await send("Continue");
    await eventually(lastTurn, (status) => status === "idle", 15_000);
    expect((await providersAccount())?.state).toBe("signed_in");
  }, 90_000);

  test("a completed turn clears the mark when the login file did not change", async () => {
    await send("FAIL:auth");
    await eventually(providersAccount, (a) => a?.state === "expired", 20_000);
    await send("Works again");
    expect(await eventually(providersAccount, (a) => a?.state === "signed_in", 20_000)).toMatchObject({
      state: "signed_in",
    });
  }, 60_000);

  test("a rejection still reading the account does not overwrite a later successful turn", async () => {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const handle = host.handleCommand.bind(host);

    // The rejection's forced account read waits, as on a slow worker, while the next turn succeeds.
    host.handleCommand = async (command) => {
      if (command.kind.case === "getProviderAccounts" && command.kind.value.refresh) {
        held.resolve();
        await release.promise;
      }

      return handle(command);
    };

    try {
      await send("FAIL:auth");
      await held.promise;
      const before = await completedTurns();
      await send("Works after the rejection");
      await eventually(completedTurns, (n) => n > before, 15_000);
    } finally {
      release.resolve();
      host.handleCommand = handle;
    }

    // Every queued account update of this worker has run: the success came last and wins, also once the stale
    // rejection's read has been answered and saved.
    await gw.core.accounts.afterTurn(workerId, async () => {});
    const states = new Set<string>();

    for (let i = 0; i < 20; i++) {
      states.add((await providersAccount())?.state ?? "");
      await Bun.sleep(100);
    }

    expect([...states]).toEqual(["signed_in"]);
  }, 60_000);

  test("a platform-wide worker is visible to owners, but none of them can replace its CLI login", async () => {
    const platform = await gw.addWorker("platform worker");
    await sql((s) => s`UPDATE workers SET owner_user_id = NULL WHERE id = ${platform.workerId}::uuid RETURNING id`);
    expect((await gw.api.getOverview({})).workers.some((w) => w.id === platform.workerId)).toBe(true);
    expect(
      await failure(gw.api.startProviderLogin({ harness: Provider.CODEX, id: "native", workerId: platform.workerId })),
    ).toContain("worker not found");
  });
});
