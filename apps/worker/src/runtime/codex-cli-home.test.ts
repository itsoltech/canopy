import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  GetProviderAccountsSchema,
  Provider,
  ProviderConfigurationMode,
  ProviderProfileKind,
  WorkerConfigSchema,
} from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { ManagedRuntime } from "effect";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyWorkerConfig, systemProbe } from "../config/remote.ts";
import { Journal } from "../journal/index.ts";
import { providerAccounts } from "./account-commands.ts";
import { HostContext } from "./host-context.ts";
import { HostState } from "./host-state.ts";
import { ProviderLogins } from "./provider-logins.ts";

function fixture() {
  const root = realpathSync(tempDir("canopy-codex-direct-"));
  const dataDir = join(root, "data");
  const cliHome = join(root, "existing");
  const privateHome = join(root, "private");
  const deviceHome = join(root, "default");
  mkdirSync(cliHome);
  mkdirSync(privateHome);
  // Old links may have been denied on Windows. Direct execution never tries to repair or replace the private files.
  writeFileSync(join(privateHome, "auth.lock"), "previous private lock");
  writeFileSync(join(privateHome, "auth.json"), "previous private login");
  writeFileSync(join(cliHome, "config.toml"), "#" + " ".repeat(300_000));
  const executable = join(root, "codex.ts");
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const isStatus = args.join(" ") === "login status";
writeFileSync(join(import.meta.dir, isStatus ? "account" : "spawn"), JSON.stringify({
  home: process.env.CODEX_HOME, hasProfileEnv: Boolean(process.env.FIXTURE_PROFILE_SECRET), args
}));
if (isStatus) {
  console.error("Logged in using ChatGPT");
  process.exit(0);
}
for await (const line of createInterface({ input: process.stdin })) {
  const { method, id } = JSON.parse(line);
  if (id === undefined) continue;
  const result = method === "initialize" ? { userAgent: "codex-fixture/0.171.0" }
    : method === "account/read" ? { account: { type: "chatgpt", email: "cli@example.test", planType: "plus" } } : {};
  console.log(JSON.stringify({ id, result }));
}
`,
    { mode: 0o700 },
  );
  const runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));

  const state = new HostState({
    dataDir,
    runtime,
    clientVersion: "test",
    deviceHomes: { claude: join(root, "claude"), codex: deviceHome },
  });

  const ctx = new HostContext(state, { applyConfig: async () => ({}), sendPreviews: () => {} });

  const config = create(WorkerConfigSchema, {
    version: 3n,
    codex: { enabled: true },
    profiles: [
      {
        id: "direct",
        providers: [Provider.CODEX],
        kind: ProviderProfileKind.NATIVE,
        executablePath: executable,
        homePath: cliHome,
        shadowHomePath: privateHome,
        userConfiguration: { mode: ProviderConfigurationMode.SHARED },
        launchArgs: [
          "-c",
          'sqlite_home="previous-override"',
          "-c",
          "features.background_paginated_rollout_migration=true",
        ],
        env: [{ name: "FIXTURE_PROFILE_SECRET", value: "fixture", secret: true }],
      },
    ],
  });

  return { root, cliHome, privateHome, deviceHome, executable, runtime, state, ctx, config };
}

test("the custom Codex executable uses one CLI home for threads, keyring status and login", async () => {
  const { root, cliHome, privateHome, deviceHome, executable, runtime, state, ctx, config } = fixture();

  try {
    const result = applyWorkerConfig(
      config,
      { ...systemProbe, which: () => null, version: () => "0.171.0" },
      ctx.ops.homes(),
    );

    if (!result.applied) throw new Error("Expected config to apply.");
    state.config = result.config;
    await ctx.ops.reconcileRuntimes();
    const spawn = JSON.parse(readFileSync(join(root, "spawn"), "utf8"));
    expect(spawn.home).toBe(cliHome);
    expect(spawn.hasProfileEnv).toBe(true);
    expect(spawn.args.filter((arg: string) => arg.startsWith("sqlite_home=")).at(-1)).toBe(
      "sqlite_home=" + JSON.stringify(privateHome),
    );
    expect(
      spawn.args.filter((arg: string) => arg.startsWith("features.background_paginated_rollout_migration=")).at(-1),
    ).toBe("features.background_paginated_rollout_migration=false");

    const group = ctx.ops.codexGroupOf("direct");
    const key = `codex/${group}`;
    const prior = state.codex.get(group);
    expect(prior).toBeDefined();

    const report = await ctx.ops.useRuntime(key, true, async () => {
      const report = await providerAccounts(
        ctx,
        create(GetProviderAccountsSchema, {
          configVersion: 3n,
          provider: Provider.CODEX,
          profileId: "direct",
          refresh: true,
        }),
      );

      expect(state.codex.get(group)).toBe(prior);
      expect(state.staleRuntimes.has(key)).toBe(true);

      return report;
    });

    await ctx.ops.reconcileRuntimes();
    expect(state.codex.get(group)).toBeDefined();
    expect(state.codex.get(group)).not.toBe(prior);
    expect(report.entries[0]?.account).toMatchObject({
      state: "signed_in",
      authMethod: "ChatGPT",
      configDir: cliHome,
      loginDir: cliHome,
      loginExecutable: executable,
    });
    expect(JSON.parse(readFileSync(join(root, "account"), "utf8"))).toEqual({
      args: ["login", "status"],
      home: cliHome,
      hasProfileEnv: false,
    });
    const login = new ProviderLogins(ctx).target(Provider.CODEX, "direct");
    expect(login.env["CODEX_HOME"]).toBe(cliHome);
    expect(login.env["FIXTURE_PROFILE_SECRET"]).toBeUndefined();
    expect(login.executable).toBe(executable);
    expect(state.codexHome("direct")).toBe(privateHome);
    expect(readFileSync(join(privateHome, "auth.lock"), "utf8")).toBe("previous private lock");
    expect(readFileSync(join(privateHome, "auth.json"), "utf8")).toBe("previous private login");
    expect(readdirSync(cliHome)).toEqual(["config.toml"]);
    expect(existsSync(deviceHome)).toBe(false);
  } finally {
    for (const group of state.codex.keys()) await ctx.ops.stopCodex(group);
    await state.accounts.close();
    await runtime.dispose();
  }
}, 15_000);
