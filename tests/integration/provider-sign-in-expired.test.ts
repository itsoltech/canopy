import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  Provider,
  ProviderConfigurationMode,
  ProviderProfileKind,
  ProviderUserConfigurationSchema,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { REJECTED_LOGIN_DETAIL } from "@canopy/domain/provider-accounts";
import { statusAcross } from "@canopy/domain/provider-instances";
import { CODEX_CLI_HOME_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { journalHello, openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { snapshot } from "./support/thread-move.ts";

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
  let serving: ReturnType<typeof serveLink>;
  let credential = "";
  let workerId = "";
  let threadId = "";
  let projectId = "";
  let workspaceId = "";
  const logs: string[] = [];

  const codexInstance = async (id = "native") =>
    (await gw.api.listProviderInstances({})).instances.find((i) => i.harness === Provider.CODEX && i.id === id);

  const providersAccount = async (id = "native") =>
    (await codexInstance(id))?.workers.find((w) => w.workerId === workerId)?.account;

  const overviewAccount = async () =>
    (await gw.api.getOverview({})).workers
      .find((w) => w.id === workerId)
      ?.providerInstances.find((i) => i.harness === Provider.CODEX && i.id === "native")?.account;

  const lastTurn = async (id = threadId) => (await gw.api.getThread({ threadId: id })).thread?.status;

  const sql = <A extends object>(run: (sql: SqlClient.SqlClient) => Effect.Effect<readonly A[], unknown>) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, run));

  async function send(text: string, id = threadId) {
    await eventually(
      () => lastTurn(id),
      (status) => status === "idle",
      15_000,
    );

    return (await gw.api.sendMessage({ threadId: id, text, clientRequestId: crypto.randomUUID() })).turn!.id;
  }

  const finished = (id: string) =>
    eventually(
      async () => (await sql((s) => s<{ status: string }>`SELECT status FROM turns WHERE id = ${id}::uuid`))[0]?.status,
      (status) => status === "completed" || status === "failed" || status === "interrupted",
      15_000,
    );

  async function startWorker() {
    runtime = ManagedRuntime.make(Journal.layer(join(dir, "data/journal.db")));
    host = new WorkerHost({
      runtime,
      dataDir: join(dir, "data"),
      clientVersion: "test",
      log: (line) => logs.push(line),
      deviceHomes: { claude: join(dir, "device-claude"), codex: deviceCodex, grok: join(dir, "device-grok") },
    });
    link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential,
      hello: {
        workerId,
        host: { os: process.platform },
        capabilities: [
          "provider_account_status",
          "probe_providers",
          "codex_device_login",
          "codex_device_login_linked",
          CODEX_CLI_HOME_CAPABILITY,
        ],
        ...(await runtime.runPromise(journalHello())),
      },
    });
    serving = serveLink(link, host, runtime);
    expect(await eventually(providersAccount, (a) => a?.state === "signed_in", 20_000)).toMatchObject({
      state: "signed_in",
    });
  }

  async function stopWorker() {
    link?.close();
    await serving;
    await host?.close();
    await runtime?.dispose();
  }

  beforeAll(async () => {
    mkdirSync(join(dir, "data"));
    mkdirSync(deviceCodex);
    // The device's Codex login: a fixture token whose refresh token has expired.
    writeFileSync(join(deviceCodex, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-expired" } }));
    gw = await startTestGateway();
    const worker = await gw.addWorker("sign-in-worker");
    workerId = worker.workerId;
    credential = worker.credential;
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          workerId,
          {
            profiles: [{ id: "native", providers: [Provider.CODEX], kind: ProviderProfileKind.NATIVE }],
            codex: { enabled: true, executablePath: executable },
            claude: { enabled: false },
            grok: { enabled: false },
          },
          gw.userId,
        ),
      ),
    );
    await startWorker();
    projectId = (await gw.api.createProject({ name: "Sign-in" })).project!.id;
    const repo = join(dir, "repo");
    mkdirSync(repo);
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;
    threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Expired login" }))
      .thread!.id;
  }, 60_000);

  afterAll(async () => {
    await stopWorker();
    await gw?.close();
  });

  test("a rejected turn shows the account as expired until the device login signs in again", async () => {
    // The CLI alone cannot tell: it reports a ChatGPT login.
    expect(await providersAccount()).toMatchObject({ state: "signed_in", authMethod: "ChatGPT", loginRevision: "" });
    const initial = statusAcross((await codexInstance())!).label;

    await send("Keep working");
    const expired = await eventually(providersAccount, (a) => a?.state === "expired", 20_000);
    expect(expired).toMatchObject({ state: "expired", authMethod: "ChatGPT", detail: REJECTED_LOGIN_DETAIL });
    expect(expired?.loginRevision).toBe("");
    expect((await overviewAccount())?.state).toBe("expired");
    const afterRejection = statusAcross((await codexInstance())!).label;
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

    const continued = await send("Continue");
    expect(await finished(continued)).toBe("completed");
    expect((await providersAccount())?.state).toBe("signed_in");

    // The gateway fixture's scripted worker stays ready throughout this worker's failed turn and recovery.
    const recovered = statusAcross((await codexInstance())!).label;
    expect([initial, afterRejection, recovered]).toEqual([
      "Ready on 2 workers",
      "1/2 workers ready",
      "Ready on 2 workers",
    ]);
  }, 90_000);

  for (const ownLogin of [false, true]) {
    const id = ownLogin ? "private" : "linked";

    test(`refresh drains and replaces the cached process after an external ${id} sign-in`, async () => {
      const target = { workerId, id, harness: Provider.CODEX };
      const shadow = join(dir, id + "-shadow");
      const source = ownLogin ? shadow : join(dir, id + "-device");
      mkdirSync(source);
      const auth = join(source, "auth.json");
      writeFileSync(auth, '{"tokens":{"access_token":"fixture-expired"}}');
      await gw.api.saveProviderInstance({
        ...target,
        create: true,
        label: id,
        kind: ProviderProfileKind.NATIVE,
        runtime: { ownLogin, shadowHomePath: shadow, ...(!ownLogin && { homePath: source }) },
        workerIds: [workerId],
      });
      expect(
        await eventually(
          () => providersAccount(id),
          (a) => a?.state === "signed_in",
          20_000,
        ),
      ).toMatchObject({
        state: "signed_in",
      });

      const thread = (
        await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, providerProfileId: id })
      ).thread!;

      const starts = () => logs.filter((line) => line === `codex runtime started (profile:${id})`).length;
      const original = starts();
      expect(original).toBeGreaterThan(0);
      await gw.api.refreshProviders({ ...target, accountOnly: true });
      expect(starts()).toBe(original);
      const held = await send("HOLD:login", thread.id);

      try {
        expect(await eventually(async () => existsSync(join(shadow, "turn-started")), Boolean, 15_000)).toBe(true);

        if (!ownLogin) unlinkSync(join(shadow, "auth.json"));
        writeFileSync(auth + ".new", '{"tokens":{"access_token":"fixture-fresh"}}');
        renameSync(auth + ".new", auth);
        expect((await gw.api.refreshProviders({ ...target, accountOnly: !ownLogin })).skipped).toEqual([]);
        expect(starts()).toBe(original);
      } finally {
        writeFileSync(join(shadow, "release-turn"), "");
      }

      expect(await finished(held)).toBe("failed");
      const recovered = await send("Continue after signing in from a terminal", thread.id);
      expect(await finished(recovered)).toBe("completed");
      expect(realpathSync(join(shadow, "auth.json"))).toBe(realpathSync(auth));
      await gw.api.refreshProviders({ ...target, accountOnly: true });
      expect(starts()).toBe(original + 1);

      unlinkSync(auth);
      await gw.api.refreshProviders({ ...target, accountOnly: true });
      const signedOut = await send("Try after signing out", thread.id);
      expect(await finished(signedOut)).toBe("failed");
      const failure = await sql((s) => s<{ error: string }>`SELECT error FROM turns WHERE id = ${signedOut}::uuid`);
      expect(failure[0]?.error).toBe(ownLogin ? "not signed in" : "no Codex login on this device");
    }, 75_000);
  }

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
    const rejectionApplied = Promise.withResolvers<void>();
    const successQueued = Promise.withResolvers<void>();
    const successApplied = Promise.withResolvers<void>();
    const handle = host.handleCommand.bind(host);
    const afterTurn = gw.core.accounts.afterTurn.bind(gw.core.accounts);
    let updates = 0;

    // A committed turn is visible before ingestion queues its account update. Observe the actual enqueue,
    // retaining the real per-worker queue, so the rejection stays held until the success is behind it.
    gw.core.accounts.afterTurn = (id, update) => {
      const applied = afterTurn(id, update);

      if (id === workerId) {
        updates++;

        if (updates === 1) void applied.then(rejectionApplied.resolve, rejectionApplied.reject);
        else if (updates === 2) {
          successQueued.resolve();
          void applied.then(successApplied.resolve, successApplied.reject);
        }
      }

      return applied;
    };

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
      await send("Works after the rejection");
      await successQueued.promise;
    } finally {
      release.resolve();
      host.handleCommand = handle;
      gw.core.accounts.afterTurn = afterTurn;
    }

    // Both real updates have finished, including the stale read and its rejection mark. The later success wins.
    await Promise.all([rejectionApplied.promise, successApplied.promise]);
    expect((await providersAccount())?.state).toBe("signed_in");
  }, 60_000);

  test("a platform-wide worker is visible to owners, but none of them can replace its CLI login", async () => {
    const platform = await gw.addWorker("platform worker");
    await sql((s) => s`UPDATE workers SET owner_user_id = NULL WHERE id = ${platform.workerId}::uuid RETURNING id`);
    expect((await gw.api.getOverview({})).workers.some((w) => w.id === platform.workerId)).toBe(true);
    expect(
      await failure(gw.api.startProviderLogin({ harness: Provider.CODEX, id: "native", workerId: platform.workerId })),
    ).toContain("worker not found");
  });

  test("a worker upgrade resumes an unconfigured native Codex thread despite a blocked private login link", async () => {
    // Reproduce the old worker's local default without saving a policy or changing the gateway configuration.
    const stored = await gw.runtime.runPromise(GatewayStore.use((s) => s.workerConfig(workerId)));
    const native = stored?.profiles.find((p) => p.id === "native" && p.providers.includes(Provider.CODEX));

    if (!stored || !native) throw new Error("Missing built-in Codex profile");
    expect(native.userConfiguration).toBeUndefined();
    native.userConfiguration = create(ProviderUserConfigurationSchema, { mode: ProviderConfigurationMode.ISOLATED });
    const auth = join(deviceCodex, "auth.json");
    writeFileSync(auth, '{"tokens":{"access_token":"fixture-before-upgrade"}}');
    await host.applyConfig(stored);
    const existing = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!.id;
    expect(await finished(await send("Before upgrade", existing))).toBe("completed");
    const lock = join(dir, "data", "codex-home", "auth.lock");
    const config = join(deviceCodex, "config.toml");
    const target = { harness: Provider.CODEX, id: "native", workerId };
    writeFileSync(config, 'model_reasoning_effort = "low"\n');
    writeFileSync(lock + ".conflict", "occupied");
    renameSync(lock + ".conflict", lock);

    try {
      // The terminal renewed the login. Reopening the isolated runtime exposes the conflicting lock.
      writeFileSync(auth + ".new", '{"tokens":{"access_token":"fixture-renewed"}}');
      renameSync(auth + ".new", auth);
      await gw.api.refreshProviders(target);
      const lockProblem = expect.stringContaining("Could not share the Codex login lock");
      expect(await eventually(providersAccount, (a) => a?.state === "error", 20_000)).toMatchObject({
        detail: lockProblem,
      });
      const rejected = await send("Continue", existing);
      expect(await finished(rejected)).toBe("failed");
      expect((await snapshot(gw, existing)).turns.find((turn) => turn.id === rejected)).toMatchObject({
        errorCode: "PROVIDER_UNAVAILABLE",
        errorClass: "configuration",
        error: lockProblem,
      });

      // The replacement worker receives the same stored version, with no home policy on the wire.
      await stopWorker();
      await startWorker();
      expect(host.config?.version).toBe(stored.version);
      const held = await send("HOLD:login", existing);

      try {
        expect(await eventually(async () => existsSync(join(deviceCodex, "turn-started")), Boolean, 15_000)).toBe(true);
      } finally {
        writeFileSync(join(deviceCodex, "release-turn"), "");
      }

      expect(await finished(held)).toBe("completed");
      expect(readFileSync(config, "utf8")).toBe('model_reasoning_effort = "low"\n');
      expect(readFileSync(lock, "utf8")).toBe("occupied");
      expect(readFileSync(auth, "utf8")).toBe('{"tokens":{"access_token":"fixture-renewed"}}');

      // An owner can still choose the private home, which encounters the original lock conflict.
      await gw.api.setInstanceWorker({
        ...target,
        overrides: { userConfiguration: { mode: ProviderConfigurationMode.ISOLATED } },
      });
      expect(await eventually(providersAccount, (a) => a?.state === "error", 20_000)).toMatchObject({
        state: "error",
        detail: lockProblem,
      });
    } finally {
      unlinkSync(lock);
    }
  }, 75_000);
});
