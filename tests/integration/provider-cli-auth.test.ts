import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { journalHello, openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("official CLI auth over gateway↔worker", () => {
  const dir = tempDir("canopy-cli-auth-");
  const data = join(dir, "data");
  const device = { claude: join(dir, "claude"), codex: join(dir, "codex"), grok: join(dir, "grok") };
  const grokAuthPath = join(dir, "custom-grok-login.json");
  const logs: string[] = [];
  let gw: TestGateway;
  let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
  let host: WorkerHost;
  let link: GatewayLink;
  let workerId = "";
  const request = (harness: Provider, id = "native") => ({ harness, id, workerId });

  const account = async (harness: Provider, id = "native") =>
    (await gw.api.listProviderInstances({})).instances
      .find((i) => i.harness === harness && i.id === id)
      ?.workers.find((w) => w.workerId === workerId)?.account;

  const sql = <A extends object>(run: (sql: SqlClient.SqlClient) => Effect.Effect<readonly A[], unknown>) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, run));

  beforeAll(async () => {
    mkdirSync(data);

    for (const home of Object.values(device)) mkdirSync(home);
    writeFileSync(join(device.claude, ".credentials.json"), "fixture-existing");
    writeFileSync(join(device.codex, "auth.json"), '{"tokens":{}}');
    writeFileSync(grokAuthPath, "fixture-existing");

    for (const name of ["auth-claude.ts", "auth-grok.ts"]) chmodSync(resolve(import.meta.dir, "fixtures", name), 0o755);
    gw = await startTestGateway();
    const worker = await gw.addWorker("Auth computer");
    workerId = worker.workerId;
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          workerId,
          {
            claude: { enabled: true, executablePath: resolve(import.meta.dir, "fixtures/auth-claude.ts") },
            codex: { enabled: true, executablePath: resolve(import.meta.dir, "fixtures/login-codex.ts") },
            grok: { enabled: true, executablePath: resolve(import.meta.dir, "fixtures/auth-grok.ts") },
          },
          gw.userId,
        ),
      ),
    );
    runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
    host = new WorkerHost({
      runtime,
      dataDir: data,
      clientVersion: "test",
      deviceHomes: { ...device, grokAuthPath },
      log: (line) => logs.push(line),
    });
    link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: worker.credential,
      hello: {
        workerId,
        host: { os: process.platform },
        capabilities: [
          "provider_account_status",
          "probe_providers",
          "codex_device_login_linked",
          "codex_device_login",
          "provider_cli_auth_v1",
        ],
        ...(await runtime.runPromise(journalHello())),
      },
    });
    void serveLink(link, host, runtime);
    await eventually(
      () => account(Provider.CLAUDE),
      (a) => a?.state === "signed_in",
      20_000,
    );
  }, 60_000);
  afterAll(async () => {
    link?.close();
    await host?.close();
    await runtime?.dispose();
    await gw?.close();
  });

  test("terminal stores carry over; Claude refresh replaces its file without a stale copy", async () => {
    expect((await account(Provider.GROK))?.state).toBe("stored");
    const file = join(device.claude, ".credentials.json");
    writeFileSync(file + ".new", "fixture-refreshed");
    renameSync(file + ".new", file);
    await gw.api.refreshProviders({ ...request(Provider.CLAUDE), accountOnly: true });
    expect(await account(Provider.CLAUDE)).toMatchObject({ state: "signed_in", plan: "refreshed" });
    await gw.api.logoutProvider(request(Provider.CLAUDE));
    expect(existsSync(file)).toBe(false);
    expect((await account(Provider.CLAUDE))?.state).toBe("signed_out");
  });

  test("Claude shares one sign-in, binds the paste to its login id, and reports success and failure", async () => {
    const [login, again] = await Promise.all([
      gw.api.startProviderLogin(request(Provider.CLAUDE)),
      gw.api.startProviderLogin(request(Provider.CLAUDE)),
    ]);

    expect(again.loginId).toBe(login.loginId);
    expect(login.requiresCode).toBe(true);
    expect(await failure(gw.api.logoutProvider(request(Provider.CLAUDE)))).toContain("Sign-in is running");
    expect(
      await failure(
        gw.api.completeProviderLogin({ ...request(Provider.CLAUDE), loginId: "wrong-login", code: "fixture-code" }),
      ),
    ).toContain("no longer waiting");
    await gw.api.completeProviderLogin({ ...request(Provider.CLAUDE), loginId: login.loginId, code: "fixture-code" });
    await eventually(
      () => account(Provider.CLAUDE),
      (a) => a?.loginId === login.loginId && a.loginOutcome === "signed_in",
      20_000,
    );
    const failed = await gw.api.startProviderLogin(request(Provider.CLAUDE));
    await gw.api.completeProviderLogin({ ...request(Provider.CLAUDE), loginId: failed.loginId, code: "wrong-code" });
    await eventually(
      () => account(Provider.CLAUDE),
      (a) => a?.loginId === failed.loginId && a.loginOutcome === "failed",
      20_000,
    );
    expect(logs.join("\n")).not.toContain("fixture-secret-must-not-leak");
    expect(logs.join("\n")).not.toContain("fixture-code");
  }, 60_000);

  test("Grok device flow reports its own result and logout removes only the selected store", async () => {
    const [login, again] = await Promise.all([
      gw.api.startProviderLogin(request(Provider.GROK)),
      gw.api.startProviderLogin(request(Provider.GROK)),
    ]);

    expect(again.loginId).toBe(login.loginId);
    expect(login.userCode).toBe("ABCD-1234");
    writeFileSync(join(device.grok, "complete"), "");
    await eventually(
      () => account(Provider.GROK),
      (a) => a?.loginId === login.loginId && a.loginOutcome === "signed_in",
      20_000,
    );
    await gw.api.logoutProvider(request(Provider.GROK));
    expect(existsSync(grokAuthPath)).toBe(false);
    expect((await account(Provider.GROK))?.state).toBe("signed_out");
    expect(existsSync(join(device.claude, ".credentials.json"))).toBe(true);
  }, 45_000);

  test("own-login Claude signs in and out without changing the terminal login", async () => {
    const own = await gw.api.saveProviderInstance({
      harness: Provider.CLAUDE,
      id: "own-login",
      create: true,
      label: "Own login",
      kind: ProviderProfileKind.NATIVE,
      runtime: { ownLogin: true },
    });

    const id = own.instance!.id;
    await gw.api.setInstanceWorker({ ...request(Provider.CLAUDE, id), enabled: true });
    await eventually(
      () => account(Provider.CLAUDE, id),
      (a) => a?.state === "signed_out",
      20_000,
    );
    const login = await gw.api.startProviderLogin(request(Provider.CLAUDE, id));
    await gw.api.completeProviderLogin({
      ...request(Provider.CLAUDE, id),
      loginId: login.loginId,
      code: "fixture-code",
    });
    await eventually(
      () => account(Provider.CLAUDE, id),
      (a) => a?.loginOutcome === "signed_in",
      20_000,
    );
    await gw.api.logoutProvider(request(Provider.CLAUDE, id));
    expect(readFileSync(join(device.claude, ".credentials.json"), "utf8")).toBe("fixture-login");
    expect((await account(Provider.CLAUDE, id))?.state).toBe("signed_out");
  }, 60_000);

  for (const harness of [Provider.CODEX, Provider.GROK])
    test(`${Provider[harness]} owns its login store and signs out without changing the terminal`, async () => {
      const name = harness === Provider.CODEX ? "codex" : "grok";

      const own = await gw.api.saveProviderInstance({
        harness,
        id: `own-${name}`,
        create: true,
        label: `Own ${name}`,
        kind: ProviderProfileKind.NATIVE,
        runtime: { ownLogin: true },
      });

      const id = own.instance!.id;
      await gw.api.setInstanceWorker({ ...request(harness, id), enabled: true });

      const initial = await eventually(
        () => account(harness, id),
        (a) => a?.state === "signed_out",
        20_000,
      );

      const source = harness === Provider.GROK ? grokAuthPath : join(device[name], "auth.json");
      writeFileSync(source, "fixture-terminal-login");
      const login = await gw.api.startProviderLogin(request(harness, id));

      if (harness === Provider.GROK) writeFileSync(join(initial!.loginDir, "complete"), "");
      await eventually(
        () => account(harness, id),
        (a) => a?.loginId === login.loginId && a.loginOutcome === "signed_in",
        20_000,
      );
      await gw.api.logoutProvider(request(harness, id));
      expect(readFileSync(source, "utf8")).toBe("fixture-terminal-login");
      expect((await account(harness, id))?.state).toBe("signed_out");
    }, 60_000);

  test("Grok failure belongs to that device sign-in and never leaks CLI stderr", async () => {
    const own = await gw.api.saveProviderInstance({
      harness: Provider.GROK,
      id: "failing-grok",
      create: true,
      label: "Failing Grok",
      kind: ProviderProfileKind.NATIVE,
      runtime: { ownLogin: true },
    });

    const id = own.instance!.id;
    await gw.api.setInstanceWorker({ ...request(Provider.GROK, id), enabled: true });

    const initial = await eventually(
      () => account(Provider.GROK, id),
      (a) => a?.state === "signed_out",
      20_000,
    );

    writeFileSync(join(initial!.loginDir, "fail"), "");
    const login = await gw.api.startProviderLogin(request(Provider.GROK, id));
    writeFileSync(join(initial!.loginDir, "complete"), "");
    await eventually(
      () => account(Provider.GROK, id),
      (a) => a?.loginId === login.loginId && a.loginOutcome === "failed",
      20_000,
    );
    expect(logs.join("\n")).not.toContain("fixture-secret-must-not-leak");
  }, 45_000);

  test("auth commands are transient, platform workers refuse every mutation, and old workers need an update", async () => {
    const entries = await sql(
      (s) => s<{ count: number }>`SELECT count(*)::int AS count FROM worker_commands WHERE worker_id=${workerId}::uuid`,
    );

    expect(entries[0]?.count).toBe(0);
    const connection = gw.core.link.connections.get(workerId)!;
    const capabilities = [...connection.hello.capabilities];
    connection.hello.capabilities = [];
    expect(await failure(gw.api.startProviderLogin(request(Provider.CLAUDE)))).toContain("Update the worker");
    expect(await failure(gw.api.logoutProvider(request(Provider.CODEX)))).toContain("Update the worker");
    connection.hello.capabilities = capabilities;

    const foreignUser = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("foreign-auth@example.test", "Foreign")),
    );

    const foreign = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "foreign", ownerUserId: foreignUser })),
    );

    for (const harness of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
      expect(await failure(gw.api.startProviderLogin({ ...request(harness), workerId: foreign.workerId }))).toContain(
        "worker not found",
      );
      expect(await failure(gw.api.logoutProvider({ ...request(harness), workerId: foreign.workerId }))).toContain(
        "worker not found",
      );
      expect(
        await failure(
          gw.api.completeProviderLogin({
            ...request(harness),
            workerId: foreign.workerId,
            loginId: "fake",
            code: "fixture-code",
          }),
        ),
      ).toContain("worker not found");
    }

    await sql((s) => s`UPDATE workers SET owner_user_id=NULL WHERE id=${workerId}::uuid RETURNING id`);

    for (const harness of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
      expect(await failure(gw.api.startProviderLogin(request(harness)))).toContain("worker not found");
      expect(await failure(gw.api.logoutProvider(request(harness)))).toContain("worker not found");
      expect(
        await failure(gw.api.completeProviderLogin({ ...request(harness), loginId: "fake", code: "fixture-code" })),
      ).toContain("worker not found");
    }
  });
});
