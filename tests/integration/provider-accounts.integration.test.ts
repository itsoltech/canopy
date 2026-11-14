import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { toJsonString } from "@bufbuild/protobuf";
import { dockerAvailable } from "@canopy/db/testing";
import { providerLoginCommand } from "@canopy/domain/provider-accounts";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { journalHello, openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { systemProbe } from "../../apps/worker/src/config/remote.ts";
import { Effect, ManagedRuntime } from "effect";
import { eventually, failure, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("provider accounts through authenticated gateway and WorkerHost", () => {
  const dir = tempDir("canopy-provider-accounts-");
  const executable = join(dir, "claude");
  const countFile = join(dir, "count");
  let gw: TestGateway;
  let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
  let host: WorkerHost;
  let link: GatewayLink;
  let workerId = "";
  const accountCommands: string[] = [];
  const count = () => readFileSync(countFile, "utf8").length;

  const account = async () =>
    (await gw.api.listProviderInstances({})).instances
      .find((i) => i.harness === Provider.CLAUDE && i.id === "native")
      ?.workers.find((w) => w.workerId === workerId)?.account;

  beforeAll(async () => {
    mkdirSync(join(dir, "data"));
    mkdirSync(join(dir, "device-claude"));
    writeFileSync(
      executable,
      `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }
if (process.argv.slice(2).join(" ") !== "auth status --json") {
  if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== "" || !process.env.CLAUDE_CONFIG_DIR?.endsWith("different-home")) process.exit(1);
  await import(${JSON.stringify(join(import.meta.dir, "fixtures/instance-claude.ts"))});
} else {
appendFileSync(${JSON.stringify(countFile)}, "x");
await Bun.sleep(100);
const modeFile = ${JSON.stringify(join(dir, "login-mode"))};
if (existsSync(modeFile)) {
  const mode = readFileSync(modeFile, "utf8");
  const storage = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const home = storage === "" ? ${JSON.stringify(join(dir, "device-claude"))} : storage ?? process.env.CLAUDE_CONFIG_DIR;
  const loggedIn = home === ${JSON.stringify(join(dir, "device-claude"))} &&
    (mode === "keychain" || (mode !== "out" && existsSync(join(home, ".credentials.json"))));
  console.log(JSON.stringify(mode === "older"
    ? { loggedIn, authMethod: "claude.ai", email: "qa@example.test", subscriptionType: "max" }
    : { loggedIn, authMethod: "claude.ai", apiProvider: "firstParty", configDirectory: home,
        loginExpiresAt: "2026-12-11T17:52:05.803Z", subscriptionType: "max",
        storedClaudeAiLogin: loggedIn, planTier: "max_20x" }));
  process.exit(loggedIn ? 0 : 1);
}
console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "qa@example.test", orgName: "Example team", subscriptionType: readFileSync(${JSON.stringify(join(dir, "plan"))}, "utf8"), accessToken: "sk-fake-never-send", orgId: "private-org-id" }));
}
`,
      { mode: 0o700 },
    );
    writeFileSync(join(dir, "plan"), "team");
    gw = await startTestGateway();
    const worker = await gw.addWorker("account-worker");
    workerId = worker.workerId;
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          workerId,
          {
            claude: { enabled: true, executablePath: executable },
            codex: { enabled: false },
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
      // macOS leaves file-based availability unknown; the CLI must read the keychain itself.
      probe: {
        ...systemProbe,
        login: (harness, home) => (harness === "claude" ? undefined : systemProbe.login!(harness, home)),
      },
      deviceHomes: {
        claude: join(dir, "device-claude"),
        claudeSecureStorage: "",
        codex: join(dir, "device-codex"),
        grok: join(dir, "device-grok"),
      },
    });
    const handle = host.handleCommand.bind(host);
    host.handleCommand = (command) => {
      if (command.kind.case === "getProviderAccounts") accountCommands.push(command.commandId);

      return handle(command);
    };

    link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: worker.credential,
      hello: {
        workerId,
        host: { os: process.platform },
        capabilities: ["provider_account_status", "probe_providers"],
        ...(await runtime.runPromise(journalHello())),
      },
    });
    void serveLink(link, host, runtime);
    await eventually(account, (a) => a?.state === "signed_in");
  }, 60_000);
  afterAll(async () => {
    link?.close();
    await host?.close();
    await runtime?.dispose();
    await gw?.close();
  });

  test("views read memory, refresh bursts coalesce, and changed configuration refreshes the actual instance home", async () => {
    expect(await account()).toMatchObject({
      state: "signed_in",
      email: "qa@example.test",
      organization: "Example team",
      plan: "team",
      configDir: "",
      loginDir: join(dir, "device-claude"),
      loginExecutable: executable,
    });
    const initial = count();
    await Promise.all(Array.from({ length: 20 }, () => gw.api.getOverview({})));
    await Promise.all(Array.from({ length: 20 }, account));
    expect(count()).toBe(initial);
    writeFileSync(join(dir, "plan"), "max");
    await Promise.all(
      Array.from({ length: 10 }, () =>
        gw.api.refreshProviders({ workerId, harness: Provider.CLAUDE, id: "native", accountOnly: true }),
      ),
    );
    expect(count()).toBe(initial + 1);
    expect((await account())?.plan).toBe("max");
    const shadow = join(dir, "different-home");
    await gw.api.setInstanceWorker({
      harness: Provider.CLAUDE,
      id: "native",
      workerId,
      enabled: true,
      overrides: { shadowHomePath: shadow },
    });
    await eventually(account, (a) => a?.configDir === shadow);
    expect((await account())?.loginDir).toBe(join(dir, "device-claude"));
    const overview = await gw.api.getOverview({});
    const payload = toJsonString(ui.GetOverviewResponseSchema, overview);
    expect(payload).not.toContain("sk-fake-never-send");
    expect(payload).not.toContain("private-org-id");
    expect(payload).not.toContain("accessToken");

    for (const commandId of accountCommands)
      expect(
        await runtime.runPromise(
          Effect.gen(function* () {
            const journal = yield* Journal;

            return yield* journal.commandResult(commandId);
          }),
        ),
      ).toBeUndefined();
  });

  test("device login checks the source home for keychain, file, signed-out and older CLI responses", async () => {
    const modeFile = join(dir, "login-mode");
    const credentials = join(dir, "device-claude", ".credentials.json");

    try {
      expect(existsSync(credentials)).toBe(false);

      for (const mode of ["keychain", "file", "out", "older"]) {
        if (mode === "file") writeFileSync(credentials, "{}", { mode: 0o600 });
        writeFileSync(modeFile, mode);
        await gw.api.refreshProviders({ workerId, harness: Provider.CLAUDE, id: "native", accountOnly: true });
        expect(await account()).toMatchObject({
          state: mode === "out" ? "signed_out" : "signed_in",
          plan: "max",
          email: mode === "older" ? "qa@example.test" : "",
          loginDir: join(dir, "device-claude"),
          configDir: join(dir, "different-home"),
        });
      }

      rmSync(credentials);
      writeFileSync(modeFile, "keychain");
      const projectId = (await gw.api.createProject({ name: "Keychain login" })).project!.id;
      const repo = join(dir, "repo");
      mkdirSync(repo);
      const workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;
      const thread = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CLAUDE })).thread!;
      await gw.api.sendMessage({ threadId: thread.id, text: "Check login", clientRequestId: crypto.randomUUID() });

      const turns = (values: ui.ThreadUpdate[]) =>
        values.flatMap((v) => {
          if (v.change.case === "snapshot") return v.change.value.turns;

          if (v.change.case === "turn") return [v.change.value];

          return [];
        });

      const updates = await watchUntil(gw.api, thread.id, (values) =>
        turns(values).some((turn) => ["completed", "failed", "interrupted"].includes(turn.status)),
      );

      expect(turns(updates).at(-1)?.status).toBe("completed");
    } finally {
      rmSync(modeFile, { force: true });
      rmSync(credentials, { force: true });
    }
  }, 30_000);

  test("sign-in targets this worker's own instance home and safely quotes executable and home paths", async () => {
    const ownHome = join(dir, "Claude's home $(unused)");
    await gw.api.saveProviderInstance({
      harness: Provider.CLAUDE,
      id: "separate-login",
      label: "Separate login",
      create: true,
      kind: ProviderProfileKind.NATIVE,
      allWorkers: true,
      runtime: { ownLogin: true, shadowHomePath: ownHome, binaryPath: executable },
    });

    const separate = async () =>
      (await gw.api.listProviderInstances({})).instances
        .find((i) => i.id === "separate-login")
        ?.workers.find((w) => w.workerId === workerId)?.account;

    const report = await eventually(separate, (a) => a?.loginDir === ownHome);
    expect(report?.loginDir).toBe(ownHome);
    expect(report?.loginExecutable).toBe(executable);
    const command = providerLoginCommand("claude", report!, "linux");
    expect(command).toBe(`CLAUDE_CONFIG_DIR='${ownHome.replaceAll("'", `'"'"'`)}' '${executable}' auth login`);
    const powershell = providerLoginCommand("claude", report!, "win32");
    expect(powershell).toBe(`$env:CLAUDE_CONFIG_DIR='${ownHome.replaceAll("'", "''")}'; & '${executable}' auth login`);

    const modeFile = join(dir, "login-mode");

    try {
      writeFileSync(modeFile, "keychain");
      await gw.api.refreshProviders({ workerId, harness: Provider.CLAUDE, id: "separate-login", accountOnly: true });
      expect((await separate())?.state).toBe("signed_out");
    } finally {
      rmSync(modeFile, { force: true });
    }
  }, 30_000);

  test("a forced refresh waits for an older cached report and then reads the current login", async () => {
    const connection = gw.core.link.connections.get(workerId)!;
    const worker = (await gw.api.getOverview({})).workers.find((w) => w.id === workerId)!;
    // Drain the ConfigApplied read, including its asynchronous overview broadcast.
    await gw.core.accounts.refresh(connection, worker.configVersion);
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const handle = host.handleCommand.bind(host);

    host.handleCommand = async (command) => {
      const result = await handle(command);

      if (command.kind.case === "getProviderAccounts" && !command.kind.value.refresh) {
        captured.resolve();
        await release.promise;
      }

      return result;
    };

    const background = gw.core.accounts.refresh(connection, worker.configVersion);

    try {
      await captured.promise;
      writeFileSync(join(dir, "plan"), "team");
      const before = count();
      const refreshed = gw.core.accounts.refresh(connection, worker.configVersion, true);
      release.resolve();
      expect(await refreshed).toBe(true);
      expect((await account())?.plan).toBe("team");
      expect(count()).toBeGreaterThan(before);
    } finally {
      release.resolve();
      await background;
      host.handleCommand = handle;
    }
  });

  test("a full provider refresh invalidates login metadata without a configuration version change", async () => {
    writeFileSync(join(dir, "plan"), "enterprise");
    const before = count();
    await gw.api.refreshProviders({ workerId });
    expect((await account())?.plan).toBe("enterprise");
    expect(count()).toBeGreaterThan(before);
  });

  test("a proxy without a configured key keeps its proxy identity and never reports a subscription", async () => {
    await gw.api.saveProviderInstance({
      harness: Provider.CLAUDE,
      id: "missing-key",
      create: true,
      label: "Office proxy",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:18682",
      workerIds: [workerId],
    });

    const proxy = await eventually(
      async () =>
        (await gw.api.listProviderInstances({})).instances
          .find((i) => i.id === "missing-key")
          ?.workers.find((w) => w.workerId === workerId)?.account,
      (a) => a?.authMethod === "Proxy",
    );

    expect(proxy).toMatchObject({
      state: "signed_out",
      authMethod: "Proxy",
      proxyName: "Office proxy",
      email: "",
      plan: "",
    });
  });

  test("foreign workers and instances cannot be queried or signed in by this owner", async () => {
    const foreignUser = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("foreign@example.test", "Foreign")),
    );

    const foreign = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "foreign", ownerUserId: foreignUser })),
    );

    const before = count();
    expect(await failure(gw.api.refreshProviders({ workerId: foreign.workerId, accountOnly: true }))).toContain(
      "worker not found",
    );
    expect(
      await failure(gw.api.startProviderLogin({ workerId: foreign.workerId, harness: Provider.CODEX, id: "native" })),
    ).toContain("worker not found");
    expect((await gw.api.getOverview({})).workers.some((w) => w.id === foreign.workerId)).toBe(false);
    expect(count()).toBe(before);
  });
});
