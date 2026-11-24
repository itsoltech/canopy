import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  CommandSchema,
  CreateThreadSchema,
  PermissionMode,
  Provider,
  ProviderConfigurationMode,
  ProviderProfileKind,
  RunBotTurnSchema,
  StartTurnSchema,
  ThreadSpecSchema,
  TurnOutcome,
  WorkerConfigSchema,
  type Command,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { systemProbe } from "@canopy/worker/config";
import { Journal } from "@canopy/worker/journal";
import { WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { botSessionInstanceKey } from "../../apps/worker/src/bots/session.ts";
import {
  cliConfig,
  fixtureLogin,
  hasFixtureToken,
  initialLogin,
  profileFlag,
  refreshedLogin,
  selectedAccount,
} from "./fixtures/instance-codex-login.ts";
import { probeRecords } from "./fixtures/instance-probe.ts";

const temp = tempDirs();
const model = "fixture-model";
const defaultAccount = "default-workspace";

async function compileCodex(root: string): Promise<string> {
  const executable = join(root, process.platform === "win32" ? "codex.exe" : "codex");

  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures", "instance-codex.ts")],
    target: "bun",
    compile: { outfile: executable },
  });

  if (!result.success) throw new AggregateError(result.logs, "Codex fixture compilation failed");

  return executable;
}

function denyWrites(path: string): () => void {
  if (process.platform === "win32") {
    const everyone = "*S-1-1-0";
    execFileSync("icacls", [path, "/deny", `${everyone}:(WD)`]);

    return () => void execFileSync("icacls", [path, "/remove:d", everyone]);
  }

  chmodSync(path, 0o500);

  return () => chmodSync(path, 0o700);
}

function expectNoTokenFiles(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);

    expect(entry.isSymbolicLink(), entry.name).toBe(false);

    if (entry.isDirectory()) expectNoTokenFiles(file);
    else if (entry.isFile()) expect(hasFixtureToken(readFileSync(file)), entry.name).toBe(false);
  }
}

function fixture(root: string, executable: string) {
  const dataDir = join(root, "data");
  const journal = join(dataDir, "journal.db");
  const selectedHome = join(root, "selected");
  const defaultHome = join(root, "device");
  const shadowHome = join(dataDir, "shadow");
  const trace = join(root, "trace.jsonl");
  const logs: string[] = [];

  for (const path of [selectedHome, defaultHome, shadowHome, join(dataDir, "pricing")])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(selectedHome, "config.toml"), cliConfig);
  writeFileSync(join(selectedHome, "auth.json"), fixtureLogin(selectedAccount, initialLogin));
  writeFileSync(join(defaultHome, "auth.json"), fixtureLogin(defaultAccount, initialLogin));
  writeFileSync(
    join(dataDir, "pricing", "openai.json"),
    JSON.stringify({ schema: 1, cooldown: 0, entries: [{ id: model, retryAt: Date.now() + 86_400_000 }] }),
  );

  const start = () => {
    const runtime = ManagedRuntime.make(Journal.layer(journal));

    const host = new WorkerHost({
      runtime,
      dataDir,
      clientVersion: "test",
      deviceHomes: { codex: defaultHome, claude: join(root, "claude"), grok: join(root, "grok") },
      probe: { ...systemProbe, which: () => null, version: () => "codex-cli 0.172.0" },
      log: (message) => logs.push(message),
    });

    const pending = () => runtime.runPromise(Journal.use((j) => j.pending(new Map())));

    return {
      apply: () => host.applyConfig(config(executable, trace, shadowHome, selectedHome)),
      command: (kind: Command["kind"]) =>
        host.handleCommand(create(CommandSchema, { commandId: crypto.randomUUID(), kind })),
      pending,
      finished: async (threadId: string, turnId: string) => {
        const deadline = Date.now() + 10_000;

        do {
          const events = await pending();

          const event = events.find(
            (event) => event.threadId === threadId && event.turnId === turnId && event.body.case === "turnFinished",
          );

          if (event?.body.case === "turnFinished") return event.body.value;
          await Bun.sleep(25);
        } while (Date.now() < deadline);

        throw new Error("Timed out waiting for the worker to journal turn completion");
      },
      close: async () => {
        await host.close();
        await runtime.dispose();
      },
    };
  };

  return { defaultHome, selectedHome, shadowHome, dataDir, trace, logs, start };
}

function config(executable: string, trace: string, shadowHomePath: string, selectedHome: string) {
  const profile = (id: string, account: string) => ({
    id,
    providers: [Provider.CODEX],
    kind: ProviderProfileKind.NATIVE,
    env: [
      { name: "INSTANCE_TRACE", value: trace },
      { name: "PROFILE_PROBE", value: id },
      { name: "LOGIN_FIXTURE_ACCOUNT", value: account },
    ],
  });

  return create(WorkerConfigSchema, {
    version: 1n,
    claude: { enabled: false },
    grok: { enabled: false },
    codex: { enabled: true, executablePath: executable },
    profiles: [
      profile("native", defaultAccount),
      {
        ...profile("selected", selectedAccount),
        homePath: selectedHome,
        shadowHomePath,
        userConfiguration: { mode: ProviderConfigurationMode.SHARED },
        launchArgs: ["-c", profileFlag],
      },
    ],
  });
}

test.skipIf(process.platform !== "win32" && process.getuid?.() === 0)(
  "WorkerHost runs a thread and a resumed bot on the selected Codex login without credential links",
  async () => {
    const root = temp("canopy-login-");
    const f = fixture(root, await compileCodex(root));
    let worker = f.start();
    const botId = crypto.randomUUID();
    const botHome = join(f.dataDir, "bots", botId, botSessionInstanceKey(Provider.CODEX, "selected"), "home");
    const project = join(root, "project");
    const restoreWrites: (() => void)[] = [];

    const botTurn = async (input: string) => {
      const turnId = crypto.randomUUID();
      expect(
        await worker.command({
          case: "runBotTurn",
          value: create(RunBotTurnSchema, {
            botId,
            turnId,
            input,
            model,
            profileId: "selected",
            provider: Provider.CODEX,
            historyJson: "[]",
            configurationKey: "fixture-bot-settings",
          }),
        }),
      ).toMatchObject({ ok: true });
      expect(
        await worker.finished(botId, turnId),
        probeRecords(f.trace)
          .map((record) => `${record.probe}/${record.event}`)
          .join(", "),
      ).toMatchObject({ outcome: TurnOutcome.COMPLETED });
    };

    try {
      // Keep the fixture's normal writes possible while denying creation of any credential link in the bot home.
      mkdirSync(join(botHome, "sessions"), { recursive: true });
      writeFileSync(join(botHome, "bot-model.json"), "{}");
      const source = join(f.selectedHome, "auth.json");

      for (const home of [f.shadowHome, botHome]) {
        restoreWrites.push(denyWrites(home));
        expect(() => symlinkSync(source, join(home, "auth.json"), "file")).toThrow();
      }

      expect(await worker.apply()).toMatchObject({ applied: true });

      mkdirSync(project);

      const thread = create(ThreadSpecSchema, {
        threadId: crypto.randomUUID(),
        provider: Provider.CODEX,
        providerProfileId: "selected",
        cwd: project,
        model,
        permissionMode: PermissionMode.READ_ONLY,
      });

      expect(
        await worker.command({ case: "createThread", value: create(CreateThreadSchema, { thread }) }),
      ).toMatchObject({ ok: true });

      const ready = (await worker.pending()).find(
        (event) => event.threadId === thread.threadId && event.body.case === "threadReady",
      );

      if (ready?.body.case !== "threadReady") throw new Error("The worker did not publish a ready Codex thread");
      thread.providerThreadId = ready.body.value.providerThreadId;

      const turnId = crypto.randomUUID();
      expect(
        await worker.command({
          case: "startTurn",
          value: create(StartTurnSchema, { thread, turnId, input: { text: "Run an ordinary turn" } }),
        }),
      ).toMatchObject({ ok: true });
      expect(await worker.finished(thread.threadId, turnId)).toMatchObject({ outcome: TurnOutcome.COMPLETED });

      await botTurn("REQUEST_FIXTURE_REFRESH");
      expect(readFileSync(source, "utf8") === fixtureLogin(selectedAccount, refreshedLogin)).toBe(true);
      await worker.close();
      worker = f.start();
      expect(await worker.apply()).toMatchObject({ applied: true });
      await botTurn("Continue the conversation");
    } finally {
      try {
        await worker.close();
      } finally {
        for (const restore of restoreWrites) restore();
      }
    }

    const records = probeRecords(f.trace);
    const turns = records.filter((record) => record.event === "turn");
    expect(turns).toHaveLength(3);
    const [ordinary, first, second] = turns;
    expect(ordinary).toMatchObject({ home: f.selectedHome, probe: "selected" });
    expect(first).toMatchObject({ home: botHome, probe: "selected" });
    expect(second).toMatchObject({ home: botHome, probe: "selected", session: first?.session });
    expect(readdirSync(join(f.selectedHome, "sessions"))).toEqual([`${ordinary?.session}.json`]);
    expect(records.find((record) => record.event === "thread/resume")).toMatchObject({ session: first?.session });
    expect(records.filter((record) => record.event === "external-login")).toHaveLength(2);
    expect(records.filter((record) => record.event === "external-refresh")).toHaveLength(1);
    const probes = records.filter((record) => ["source-token", "source-refresh"].includes(record.event));
    expect(probes.filter((record) => record.event === "source-refresh")).toHaveLength(1);
    expect(probes.every((record) => record.home === f.selectedHome && record.probe === "selected")).toBe(true);

    expect(readdirSync(f.shadowHome)).toEqual([]);
    expect(readFileSync(join(f.selectedHome, "config.toml"), "utf8")).toBe(cliConfig);
    expect(readFileSync(join(f.defaultHome, "auth.json"), "utf8") === fixtureLogin(defaultAccount, initialLogin)).toBe(
      true,
    );
    expect(hasFixtureToken(f.logs.join("\n"))).toBe(false);
    expect(hasFixtureToken(readFileSync(f.trace))).toBe(false);
    expectNoTokenFiles(f.dataDir);
  },
  30_000,
);
