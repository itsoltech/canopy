import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { Effect, ManagedRuntime } from "effect";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

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
    writeFileSync(
      executable,
      `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }
if (process.argv.slice(2).join(" ") !== "auth status --json") process.exit(1);
appendFileSync(${JSON.stringify(countFile)}, "x");
await Bun.sleep(100);
console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "qa@example.test", orgName: "Example team", subscriptionType: readFileSync(${JSON.stringify(join(dir, "plan"))}, "utf8"), accessToken: "sk-fake-never-send", orgId: "private-org-id" }));
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
      deviceHomes: {
        claude: join(dir, "device-claude"),
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
  }, 30_000);

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
