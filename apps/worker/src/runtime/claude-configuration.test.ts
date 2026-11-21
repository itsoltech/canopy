import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ProviderConfigurationMode, ProviderProfileKind, WorkerConfigSchema } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Exit, ManagedRuntime, Scope } from "effect";
import { applyWorkerConfig } from "../config/remote.ts";
import { Journal } from "../journal/index.ts";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import { HostContext } from "./host-context.ts";
import { HostState } from "./host-state.ts";
import { probeRecords } from "../../../../tests/integration/fixtures/instance-probe.ts";

async function fixture() {
  const root = realpathSync(tempDir("canopy-claude-configuration-runtime-"));
  const source = join(root, "source");
  const login = join(root, "login");
  const privateHome = join(root, "private");
  const trace = join(root, "trace.jsonl");
  mkdirSync(source);
  mkdirSync(login);
  writeFileSync(join(source, ".credentials.json"), "source-fixture-login");
  writeFileSync(join(source, "settings.json"), '{"language":"English"}');
  writeFileSync(join(login, ".credentials.json"), "independent-fixture-login");
  const runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));

  const state = new HostState({
    runtime,
    dataDir: join(root, "data"),
    clientVersion: "test",
    deviceHomes: { claude: login, codex: join(root, "codex") },
  });

  const ctx = new HostContext(state, { applyConfig: async () => ({}), sendPreviews: () => {} });
  const executable = resolve(import.meta.dir, "../../../../tests/integration/fixtures/instance-claude.ts");

  const applied = applyWorkerConfig(
    create(WorkerConfigSchema, {
      version: 1n,
      claude: { enabled: true, executablePath: executable },
      profiles: [
        {
          id: "shared",
          providers: [Provider.CLAUDE],
          kind: ProviderProfileKind.NATIVE,
          shadowHomePath: privateHome,
          env: [{ name: "INSTANCE_TRACE", value: trace }],
          userConfiguration: { mode: ProviderConfigurationMode.SHARED, sourcePath: source },
        },
      ],
    }),
    { which: () => executable, version: () => "1.0.0", realDirectory: (path) => path, login: () => "fixture login" },
    { dataDir: state.options.dataDir, claude: login, codex: join(root, "codex") },
  );

  if (!applied.applied) throw new Error("Expected configuration to apply.");
  state.config = applied.config;
  const profile = applied.config.profiles.find((status) => status.config.id === "shared")?.resolved;

  if (!profile) throw new Error("Expected shared Claude to be available.");

  return { runtime, ctx, state, profile, source, login, privateHome, trace };
}

test("shared runtime uses the selected source in the real SDK and prepares only its private home", async () => {
  const f = await fixture();
  const before = readdirSync(f.source).sort();

  try {
    // An older runtime may drain after a policy change; new imports use the configured destination.
    f.state.claudeHomes.set("shared", f.privateHome);
    expect(f.state.claudeHome("shared")).toBe(f.source);
    await f.ctx.ops.startClaude(f.profile, "fixture");
    const handle = f.state.claude.get("shared");

    if (!handle) throw new Error("Expected shared runtime to start.");
    expect(f.state.claudeHome("shared")).toBe(f.source);
    expect(existsSync(f.privateHome)).toBe(true);
    expect(readdirSync(f.source).sort()).toEqual(before);
    expect(readFileSync(join(f.source, ".credentials.json"), "utf8")).toBe("source-fixture-login");
    await f.runtime.runPromise(
      Effect.provide(
        ClaudeThreads.use((threads) => threads.listModels("shared")),
        handle.context,
      ),
    );
    expect(probeRecords(f.trace).some((record) => record.home === f.source)).toBe(true);
    expect(readFileSync(join(f.login, ".credentials.json"), "utf8")).toBe("independent-fixture-login");
  } finally {
    for (const handle of f.state.claude.values()) await Effect.runPromise(Scope.close(handle.scope, Exit.void));
    await f.runtime.dispose();
  }
}, 20_000);

test("runtime restart does not recreate a deleted private home bound to older sessions", async () => {
  const f = await fixture();

  try {
    mkdirSync(f.privateHome);
    await f.runtime.runPromise(
      Journal.use((journal) => journal.bindClaudeSessionHome("retained-thread", f.privateHome)),
    );
    rmSync(f.privateHome, { recursive: true });
    await expect(f.ctx.ops.startClaude(f.profile, "fixture")).rejects.toThrow("session home is unavailable");
    expect(existsSync(f.privateHome)).toBe(false);
    expect(readFileSync(join(f.source, ".credentials.json"), "utf8")).toBe("source-fixture-login");
  } finally {
    for (const handle of f.state.claude.values()) await Effect.runPromise(Scope.close(handle.scope, Exit.void));
    await f.runtime.dispose();
  }
});

test("model defaults use the instance effort before the selected device or user source", async () => {
  const f = await fixture();
  const executable = join(f.source, "models-fixture.ts");
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type !== "control_request") continue;
  process.stdout.write(JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success", request_id: message.request_id,
      response: { commands: [], agents: [], models: [{
        value: "sonnet", displayName: "Sonnet", description: "Fixture model",
        supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"]
      }] }
    }
  }) + "\\n");
}
`,
  );
  chmodSync(executable, 0o700);
  writeFileSync(join(f.source, "settings.json"), '{"effortLevel":"low"}');
  writeFileSync(join(f.login, "settings.json"), '{"effortLevel":"high"}');

  try {
    for (const { mode, effort, expected } of [
      { mode: ProviderConfigurationMode.ISOLATED, expected: "high" },
      { mode: ProviderConfigurationMode.LOCAL, expected: "low" },
      { mode: ProviderConfigurationMode.SHARED, expected: "low" },
      { mode: ProviderConfigurationMode.SHARED, effort: "medium", expected: "medium" },
    ] as const) {
      const profile = {
        ...f.profile,
        runtime: {
          ...f.profile.runtime,
          executablePath: executable,
          ...(effort && { claudeSettings: { effortLevel: effort } }),
          userConfiguration: { mode, sourcePath: f.source, instructions: false, skills: false, hooks: false },
        },
      };

      await f.ctx.ops.startClaude(profile, `effort-${mode}`);
      const handle = f.state.claude.get("shared");

      if (!handle) throw new Error("Expected Claude runtime to start.");

      const catalog = await f.runtime.runPromise(
        Effect.provide(
          ClaudeThreads.use((threads) => threads.listModels("shared")),
          handle.context,
        ),
      );

      expect(catalog.models[0]?.defaultEffort).toBe(expected);
      await f.ctx.ops.stopClaude("shared");
    }
  } finally {
    for (const handle of f.state.claude.values()) await Effect.runPromise(Scope.close(handle.scope, Exit.void));
    await f.runtime.dispose();
  }
}, 20_000);
