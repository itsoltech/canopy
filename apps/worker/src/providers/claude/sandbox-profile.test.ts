import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { query, type Settings } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ProviderConfigurationMode,
  SandboxProfileSchema,
  ThreadSpecSchema,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { sandboxBinding } from "@canopy/domain/sandbox-profiles";
import { tempDirs } from "@canopy/testing";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Journal } from "../../journal/index.ts";
import { decodeJsonObject } from "../json.ts";
import { resolveProfiles } from "../profiles.ts";
import { checkClaudeSandboxPolicy } from "./sandbox-profile.ts";
import { claudeQueryConfiguration } from "./query-configuration.ts";
import { ClaudeThreads } from "./threads.ts";

const temp = tempDirs();
const env = { ANTHROPIC_API_KEY: "synthetic", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };

const profile = create(SandboxProfileSchema, {
  id: "11111111-1111-4111-8111-111111111111",
  name: "GitHub",
  allowedDomains: ["github.com", "api.github.com"],
});

for (const domains of [profile.allowedDomains, []]) {
  test(`Claude SDK receives the named sandbox at spawn (${domains.length} domains)`, async () => {
    const home = temp("canopy-claude-sandbox-settings-");
    const executable = join(home, "synthetic-claude");
    const source = join(home, "source");
    mkdirSync(source);
    writeFileSync(
      join(source, "settings.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "synthetic-hook-never-executed" }] }] },
        sandbox: { enabled: false, network: { allowedDomains: ["elsewhere.example"], httpProxyPort: 4567 } },
      }),
    );
    let args: readonly string[] = [];
    const stop = new Error("Synthetic spawn boundary");

    const config = await claudeQueryConfiguration(
      {
        home,
        sourceHome: source,
        userConfiguration: {
          mode: ProviderConfigurationMode.LOCAL,
          sourcePath: "",
          hooks: true,
          skills: true,
          instructions: false,
        },
      },
      home,
      true,
      {},
      {
        pathToClaudeCodeExecutable: executable,
        env,
        settingSources: ["user", "project", "local"],
        extraArgs: { "allow-dangerously-skip-permissions": null },
        plugins: [{ type: "local", path: source }],
        spawnClaudeCodeProcess: (launch) => {
          expect(launch.command).toBe(executable);
          expect(launch.env["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]).toBe("1");
          args = launch.args;
          throw stop;
        },
      },
      "default",
      { allowedDomains: domains },
    );

    try {
      await expect(
        (async () => {
          const q = query({ prompt: "", options: config.options });

          try {
            await q.initializationResult();
          } finally {
            q.close();
          }
        })(),
      ).rejects.toThrow(stop.message);
      expect(args).toContain("--setting-sources=");
      expect(args).toContain("--permission-mode=acceptEdits");
      expect(args).not.toContain("--allow-dangerously-skip-permissions");
      expect(args).not.toContain("--plugin-dir");
      const settings = decodeJsonObject(JSON.parse(args[args.indexOf("--settings") + 1] ?? ""));
      expect(settings["disableAllHooks"]).toBe(true);
      expect(settings["hooks"]).toBeUndefined();
      expect(settings["sandbox"]).toEqual({
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        enableWeakerNestedSandbox: false,
        allowNestedUserNamespaces: false,
        enableWeakerNetworkIsolation: false,
        allowAppleEvents: false,
        network: {
          strictAllowlist: true,
          allowedDomains: domains,
          allowAllUnixSockets: false,
          allowLocalBinding: false,
        },
      });
    } finally {
      await config.close();
    }
  });
}

test("Claude refuses managed policy that would change or bypass the requested domain list", () => {
  const unsafe: Settings[] = [
    { sandbox: { network: { allowedDomains: ["*.github.com"] } } },
    { sandbox: { network: { httpProxyPort: 3468 } } },
    { sandbox: { network: { allowManagedDomainsOnly: true } } },
    { sandbox: { excludedCommands: ["git *"] } },
    { sandbox: { allowUnsandboxedCommands: true } },
    { permissions: { allow: ["WebFetch(domain:elsewhere.example)"] } },
    { permissions: { ask: ["Bash(git *)"] } },
    { policyHelper: { path: "/synthetic-policy" } },
  ];

  for (const settings of unsafe) expect(() => checkClaudeSandboxPolicy(settings, profile.allowedDomains)).toThrow();
  expect(() =>
    checkClaudeSandboxPolicy(
      { sandbox: { network: { deniedDomains: ["api.github.com"] } }, permissions: { deny: ["Bash(git *)"] } },
      profile.allowedDomains,
    ),
  ).not.toThrow();
});

const supportedPlatform = process.platform === "linux" || process.platform === "darwin";

test.skipIf(!supportedPlatform)("Claude holds user input until the required sandbox accepts startup", async () => {
  const home = temp("canopy-claude-sandbox-startup-");
  const executable = join(home, "refusing-claude");
  const marker = join(home, "spawned");
  const versionPath = join(home, "version");
  writeFileSync(versionPath, "2.1.316");
  writeFileSync(
    executable,
    `#!${process.execPath}
    import { readFileSync, writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    if (process.argv.includes("--version")) {
      console.log(readFileSync(${JSON.stringify(versionPath)}, "utf8") + " (Claude Code)");
      process.exit(0);
    }
    writeFileSync(${JSON.stringify(marker)}, "");
    for await (const line of createInterface({ input: process.stdin })) {
      if (JSON.parse(line).type === "user") throw new Error("Unexpected user input");
      console.log(JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Sandbox required but unavailable: synthetic startup failure"],
        startup_failure_reason: "sandbox_required_unavailable",
        session_id: crypto.randomUUID(),
        uuid: crypto.randomUUID(),
      }));
      process.exit(1);
    }`,
    { mode: 0o700 },
  );
  const events: ThreadEvent[] = [];
  const instance = resolveProfiles([{ id: "native", kind: "native", providers: ["claude"] }])[0]?.resolved;

  const runtime = ManagedRuntime.make(
    ClaudeThreads.layer({
      home,
      executable,
      baseEnv: { PATH: process.env["PATH"], ...env },
      nativeTools: { nativeSubagents: false, nativeScheduling: false },
      profile: () => instance,
      publish: (event) => events.push(event),
      interact: async () => create(InteractionResponseSchema),
      callTool: async () => create(AgentToolResultSchema),
    }).pipe(Layer.provideMerge(Journal.layer(join(home, "journal.db")))),
  );

  const binding = sandboxBinding(profile);

  const spec = create(ThreadSpecSchema, {
    threadId: crypto.randomUUID(),
    cwd: home,
    provider: Provider.CLAUDE,
    permissionMode: PermissionMode.FULL_AUTO,
    sandboxProfile: binding,
  });

  const start = (thread = spec) =>
    runtime.runPromise(
      ClaudeThreads.use((threads) =>
        threads.startTurn(thread, crypto.randomUUID(), create(UserInputSchema, { text: "No input before startup" })),
      ).pipe(Effect.timeout("5 seconds")),
    );

  try {
    await expect(start({ ...spec, permissionMode: PermissionMode.FULL_ACCESS })).rejects.toThrow("Choose Sandbox mode");
    await expect(start({ ...spec, sandboxProfile: { ...binding, digest: "changed" } })).rejects.toThrow(
      "does not match its immutable snapshot",
    );
    expect(existsSync(marker)).toBe(false);
    writeFileSync(versionPath, "2.1.400");
    await expect(start()).rejects.toThrow("Use one of the verified Claude Code versions");
    expect(existsSync(marker)).toBe(false);
    writeFileSync(versionPath, "2.1.316");

    const workspace = join(home, ".claude");
    mkdirSync(workspace);

    for (const [source, path, settings] of [
      ["user", join(home, "settings.json"), { permissions: { deny: ["Read(./private)"] } }],
      ["project", join(workspace, "settings.json"), { sandbox: { filesystem: { denyWrite: ["./private"] } } }],
      ["local", join(workspace, "settings.local.json"), { sandbox: { network: { deniedDomains: ["github.com"] } } }],
    ] as const) {
      writeFileSync(path, JSON.stringify(settings));
      await expect(start()).rejects.toThrow(`Claude ${source} settings contain restrictions`);
      expect(existsSync(marker)).toBe(false);
      unlinkSync(path);
    }

    await expect(start()).rejects.toThrow("required command sandbox is unavailable");
    expect(readFileSync(marker, "utf8")).toBe("");
    expect(events.some((event) => event.body.case === "turnStarted")).toBe(false);
  } finally {
    await runtime.dispose();
  }
});
