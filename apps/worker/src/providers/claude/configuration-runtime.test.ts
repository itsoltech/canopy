import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  ItemStatus,
  PermissionMode,
  Provider,
  ProviderConfigurationMode,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
  type ThreadEvent,
  type ThreadSpec,
} from "@canopy/contracts";
import { environmentBlock } from "@canopy/domain/agent-environment";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer } from "effect";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeModel } from "../../import/fixtures/fake-model.ts";
import { Journal } from "../../journal/index.ts";
import { DEFAULT_NATIVE_TOOL_POLICY } from "../native-tools.ts";
import { resolveProfiles, type ProfileUserConfiguration } from "../profiles.ts";
import { claudeConfigurationHomes } from "./configuration-homes.ts";
import { prepareClaudeHome } from "./home.ts";
import { spawnClaude } from "./spawn.ts";
import { ClaudeThreads } from "./threads.ts";
import { transcriptPath } from "./transcript.ts";

const temp = tempDirs();
const executable = Bun.which("claude");
const nativeTest = test.skipIf(!executable);
const selectedRule = "SELECTED_USER_CONFIGURATION_RULE";
const managedRule = "ASSIGNED_PLATFORM_CONFIGURATION_RULE";
const blockedRule = "SOURCE_MANAGED_BLOCK_MUST_NOT_APPLY";
const selectedSkill = "configuration-runtime-skill";

function fixture() {
  const root = temp("canopy-claude-configuration-runtime-");
  const source = join(root, "selected [configuration]");
  const login = join(root, "independent-login");
  const dataDir = join(root, "data");
  const cwd = join(root, "workspace");
  const hookOutput = join(root, "selected-hook.json");
  const unwanted = join(root, "blocked-executable");

  for (const path of [source, login, dataDir, cwd, join(source, "skills", selectedSkill)])
    mkdirSync(path, { recursive: true });

  const hook = {
    type: "command",
    command: process.execPath,
    args: [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({home:process.env.CLAUDE_CONFIG_DIR,login:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR}))",
      hookOutput,
    ],
  };

  const settings = JSON.stringify({
    attribution: false,
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", PRIVATE_CONFIGURATION: "BLOCKED_ENV_VALUE" },
    permissions: { defaultMode: "bypassPermissions", allow: ["Bash(*)"] },
    sandbox: { enabled: false },
    apiKeyHelper: "BLOCKED_API_KEY_HELPER",
    hooks: { UserPromptSubmit: [{ hooks: [hook] }] },
    enabledPlugins: { "blocked-plugin@fixture": true },
  });

  const instructions = `${selectedRule}\n${environmentBlock(blockedRule)}\n`;
  writeFileSync(join(source, "settings.json"), settings);
  writeFileSync(join(source, "CLAUDE.md"), instructions);
  writeFileSync(join(source, ".credentials.json"), "SYNTHETIC_SOURCE_LOGIN_MUST_STAY_UNCHANGED");
  writeFileSync(join(login, ".credentials.json"), "SYNTHETIC_INDEPENDENT_LOGIN_MUST_STAY_UNCHANGED");
  writeFileSync(
    join(source, "skills", selectedSkill, "SKILL.md"),
    `---\nname: ${selectedSkill}\ndescription: Inspect a configuration runtime fixture\n---\nSay fixture.\n`,
  );
  writeFileSync(
    join(source, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        blocked: {
          command: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'unwanted')", unwanted],
        },
      },
    }),
  );

  const model = startFakeModel();

  const profile = resolveProfiles([
    { id: "fixture", kind: "cliproxyapi", providers: ["claude"], baseUrl: model.url, apiKey: "synthetic" },
  ]).find((status) => status.config.id === "fixture")!.resolved!;

  return { root, source, login, dataDir, cwd, hookOutput, unwanted, settings, instructions, model, profile };
}

type Fixture = ReturnType<typeof fixture>;

function policy(mode: ProviderConfigurationMode, enabled: boolean, sourcePath = ""): ProfileUserConfiguration {
  return { mode, sourcePath, instructions: enabled, skills: enabled, hooks: enabled };
}

function selection(f: Fixture, userConfiguration: ProfileUserConfiguration, ownLogin = false) {
  const selected = claudeConfigurationHomes(
    f.dataDir,
    "fixture",
    { homePath: f.login, ownLogin, userConfiguration },
    f.login,
    f.root,
  );

  const home = prepareClaudeHome({
    dataDir: f.dataDir,
    path: selected.platformHome,
    deviceClaudeHome: f.login,
    protectedDeviceHome: f.login,
    linkDeviceLogin: true,
    ownLogin,
  });

  writeFileSync(join(selected.platformHome, "CLAUDE.md"), environmentBlock(managedRule));

  return { ...selected, secureStorageDir: home.secureStorageDir };
}

function thread(f: Fixture): ThreadSpec {
  return create(ThreadSpecSchema, {
    threadId: crypto.randomUUID(),
    provider: Provider.CLAUDE,
    providerProfileId: "fixture",
    model: "claude-haiku-5-5",
    permissionMode: PermissionMode.READ_ONLY,
    cwd: f.cwd,
  });
}

/** Each call opens and drains a real adapter and its durable journal, like a cold worker restart. */
async function turn(f: Fixture, selected: ReturnType<typeof selection>, spec: ThreadSpec, text: string) {
  const events: ThreadEvent[] = [];
  const turnId = crypto.randomUUID();
  let interactions = 0;

  const program = Effect.gen(function* () {
    const threads = yield* ClaudeThreads;
    const journal = yield* Journal;

    if (!spec.providerThreadId) spec.providerThreadId = yield* threads.create(spec);
    yield* threads.startTurn(spec, turnId, create(UserInputSchema, { text }));

    while (!events.some((event) => event.turnId === turnId && event.body.case === "turnFinished"))
      yield* Effect.sleep("10 millis");

    const finished = events.find((event) => event.turnId === turnId && event.body.case === "turnFinished");
    expect(finished?.body.case === "turnFinished" && finished.body.value).toMatchObject({
      outcome: TurnOutcome.COMPLETED,
      reason: "",
    });
    const bound = yield* journal.claudeSessionHome(spec.threadId);

    if (finished) yield* journal.ack(spec.threadId, finished.journalSeq);

    return bound;
  }).pipe(
    Effect.provide(
      ClaudeThreads.layer({
        home: selected.home,
        runtimeOf: () => selected,
        executable: executable!,
        baseEnv: {
          PATH: process.env["PATH"],
          HOME: f.root,
          USERPROFILE: f.root,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: selected.secureStorageDir,
          DISABLE_NONESSENTIAL_TRAFFIC: "1",
          TMPDIR: f.root,
        },
        nativeTools: DEFAULT_NATIVE_TOOL_POLICY,
        profile: () => f.profile,
        publish: (event) => events.push(event),
        interact: async () => {
          interactions++;

          return create(InteractionResponseSchema, { allow: false });
        },
        callTool: async () => create(AgentToolResultSchema, { isError: true }),
      }).pipe(Layer.provideMerge(Journal.layer(join(f.dataDir, "journal.db")))),
    ),
    Effect.timeout("20 seconds"),
  );

  const bound = await Effect.runPromise(program);
  const request = f.model.requests.findLast((body) => body.includes(text) && body.includes('"tools":'));
  expect(request).toBeDefined();

  return { bound, request: request!, events, interactions };
}

function sourceUnchanged(f: Fixture) {
  expect(readFileSync(join(f.source, "settings.json"), "utf8")).toBe(f.settings);
  expect(readFileSync(join(f.source, "CLAUDE.md"), "utf8")).toBe(f.instructions);
  expect(readFileSync(join(f.source, ".credentials.json"), "utf8")).toBe("SYNTHETIC_SOURCE_LOGIN_MUST_STAY_UNCHANGED");
  expect(readFileSync(join(f.login, ".credentials.json"), "utf8")).toBe(
    "SYNTHETIC_INDEPENDENT_LOGIN_MUST_STAY_UNCHANGED",
  );
  expect(existsSync(f.unwanted)).toBe(false);
}

for (const mode of [
  ProviderConfigurationMode.ISOLATED,
  ProviderConfigurationMode.LOCAL,
  ProviderConfigurationMode.SHARED,
]) {
  for (const enabled of mode === ProviderConfigurationMode.ISOLATED ? [true] : [false, true]) {
    nativeTest(
      `Claude configuration mode ${ProviderConfigurationMode[mode]} enforces ${enabled ? "enabled" : "disabled"} scopes through the adapter`,
      async () => {
        const f = fixture();
        const ownLogin = mode === ProviderConfigurationMode.SHARED && enabled;
        const selected = selection(f, policy(mode, enabled, f.source), ownLogin);
        const spec = thread(f);

        try {
          const actual = await turn(f, selected, spec, "FIXTURE_TOOL_WRITE_CONFIGURATION");
          const configured = mode !== ProviderConfigurationMode.ISOLATED;
          expect(actual.bound).toBe(mode === ProviderConfigurationMode.SHARED ? f.source : selected.platformHome);
          expect(transcriptPath(actual.bound!, spec.providerThreadId)).toBeDefined();
          expect(actual.request.includes("Co-Authored-By:")).toBe(mode === ProviderConfigurationMode.ISOLATED);
          expect(actual.request.includes(selectedRule)).toBe(configured && enabled);
          expect(actual.request.includes(selectedSkill)).toBe(configured && enabled);
          expect(actual.request).toContain(managedRule);
          expect(actual.request).not.toContain(blockedRule);
          expect(actual.request).not.toContain("BLOCKED_ENV_VALUE");
          expect(actual.request).not.toContain("BLOCKED_API_KEY_HELPER");
          expect(actual.interactions).toBe(0);
          expect(existsSync(join(f.cwd, "fixture-write.txt"))).toBe(false);
          expect(
            actual.events.some(
              (event) =>
                event.body.case === "itemCompleted" &&
                event.body.value.item?.content.case === "commandExecution" &&
                event.body.value.item.status === ItemStatus.FAILED,
            ),
          ).toBe(true);
          expect(existsSync(f.hookOutput)).toBe(configured && enabled);

          if (configured && enabled)
            expect(JSON.parse(readFileSync(f.hookOutput, "utf8"))).toEqual({
              home: selected.home,
              login: ownLogin ? selected.platformHome : f.login,
            });

          sourceUnchanged(f);
        } finally {
          await f.model.stop();
        }
      },
      30_000,
    );
  }
}

for (const mode of [ProviderConfigurationMode.LOCAL, ProviderConfigurationMode.SHARED]) {
  for (const event of ["PreToolUse", "PermissionRequest"]) {
    nativeTest(
      `Claude ${ProviderConfigurationMode[mode]} accepts ${event} hooks with native permission handling`,
      async () => {
        const f = fixture();

        const hookSpecificOutput =
          event === "PreToolUse"
            ? { hookEventName: event, permissionDecision: "allow" }
            : { hookEventName: event, decision: { behavior: "allow" } };

        const hook = {
          type: "command",
          command: process.execPath,
          args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput }))})`],
        };

        f.settings = JSON.stringify({ hooks: { [event]: [{ matcher: "Bash", hooks: [hook] }] } });
        writeFileSync(join(f.source, "settings.json"), f.settings);

        try {
          for (const enabled of [false, true]) {
            const selected = selection(f, policy(mode, enabled, f.source));
            const spec = thread(f);
            spec.permissionMode = PermissionMode.ASK;
            const actual = await turn(f, selected, spec, "FIXTURE_TOOL_WRITE_PERMISSION_HOOK");

            // The CLI does not run PermissionRequest hooks in SDK mode; canUseTool handles the request.
            const approved = enabled && event === "PreToolUse";

            expect(actual.interactions).toBe(approved ? 0 : 1);
            expect(existsSync(join(f.cwd, "fixture-write.txt"))).toBe(approved);

            if (approved) expect(readFileSync(join(f.cwd, "fixture-write.txt"), "utf8")).toBe("FIXTURE_TOOL_OUTPUT");
          }

          sourceUnchanged(f);
        } finally {
          await f.model.stop();
        }
      },
      30_000,
    );
  }
}

/** Native baseline for permission-hook behavior in a disposable real-CLI fixture. */
async function nativePermissionHook(f: Fixture, enabled = false) {
  const settings = join(f.root, "native-hook-settings.json");
  const hookSpecificOutput = { hookEventName: "PreToolUse", permissionDecision: "allow" };

  const hook = {
    type: "command",
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput }))})`],
  };

  writeFileSync(
    settings,
    JSON.stringify({ hooks: enabled ? { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] } : {} }),
  );
  let approvals = 0;
  let completed = false;

  const q = query({
    prompt: "FIXTURE_TOOL_WRITE_NATIVE_HOOK",
    options: {
      cwd: f.cwd,
      pathToClaudeCodeExecutable: executable!,
      spawnClaudeCodeProcess: spawnClaude,
      env: {
        PATH: process.env["PATH"],
        HOME: f.root,
        USERPROFILE: f.root,
        CLAUDE_CONFIG_DIR: join(f.root, "native-home"),
        ANTHROPIC_BASE_URL: f.model.url,
        ANTHROPIC_API_KEY: "synthetic",
        DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      permissionMode: "default",
      canUseTool: async () => {
        approvals++;

        return { behavior: "deny", message: "Fixture denies all writes" };
      },
      tools: ["Bash"],
      strictMcpConfig: true,
      settingSources: [],
      settings,
      maxTurns: 2,
    },
  });

  for await (const message of q) {
    if (message.type !== "result") continue;
    expect(message.subtype).toBe("success");
    completed = true;
  }

  expect(completed).toBe(true);

  return approvals;
}

async function nativeAllowedTools(f: Fixture, enabled = false) {
  const plugin = join(f.root, "native-permission-plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, "commands"), { recursive: true });
  writeFileSync(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "fixture-permissions", version: "1.0.0" }),
  );
  writeFileSync(
    join(plugin, "commands", "write-check.md"),
    `---\ndescription: Permission fixture\n${enabled ? "allowed-tools: Bash(*)\n" : ""}---\nRun the write check FIXTURE_TOOL_WRITE_NATIVE_ALLOWED.\n`,
  );
  let approvals = 0;
  let completed = false;

  const q = query({
    prompt: "/fixture-permissions:write-check",
    options: {
      cwd: f.cwd,
      pathToClaudeCodeExecutable: executable!,
      spawnClaudeCodeProcess: spawnClaude,
      env: {
        PATH: process.env["PATH"],
        HOME: f.root,
        USERPROFILE: f.root,
        CLAUDE_CONFIG_DIR: join(f.root, "native-home"),
        ANTHROPIC_BASE_URL: f.model.url,
        ANTHROPIC_API_KEY: "synthetic",
        DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      permissionMode: "default",
      canUseTool: async () => {
        approvals++;

        return { behavior: "deny", message: "Fixture denies all writes" };
      },
      tools: ["Bash"],
      plugins: [{ type: "local", path: plugin, skipMcpDiscovery: true }],
      strictMcpConfig: true,
      settingSources: [],
      maxTurns: 2,
    },
  });

  for await (const message of q) {
    if (message.type !== "result") continue;
    expect(message.subtype).toBe("success");
    completed = true;
  }

  expect(completed).toBe(true);

  return approvals;
}

nativeTest(
  "native Claude PreToolUse approval bypasses a denying SDK permission callback",
  async () => {
    const f = fixture();

    try {
      expect(await nativePermissionHook(f)).toBe(1);
      expect(existsSync(join(f.cwd, "fixture-write.txt"))).toBe(false);
      expect(await nativePermissionHook(f, true)).toBe(0);
      expect(readFileSync(join(f.cwd, "fixture-write.txt"), "utf8")).toBe("FIXTURE_TOOL_OUTPUT");
    } finally {
      await f.model.stop();
    }
  },
  30_000,
);

nativeTest(
  "native Claude plugin allowed-tools frontmatter bypasses a denying SDK permission callback",
  async () => {
    const f = fixture();

    try {
      expect(await nativeAllowedTools(f)).toBe(1);
      expect(existsSync(join(f.cwd, "fixture-write.txt"))).toBe(false);
      expect(await nativeAllowedTools(f, true)).toBe(0);
      expect(readFileSync(join(f.cwd, "fixture-write.txt"), "utf8")).toBe("FIXTURE_TOOL_OUTPUT");
    } finally {
      await f.model.stop();
    }
  },
  30_000,
);

nativeTest(
  "a cold Claude resume retains the original shared home after policy and source changes while new sessions use the new home",
  async () => {
    const f = fixture();
    const spec = thread(f);

    try {
      const shared = selection(f, policy(ProviderConfigurationMode.SHARED, false, f.source));
      const first = await turn(f, shared, spec, "FIXTURE_DURABLE_CONFIGURATION_FIRST");
      const otherSource = join(f.root, "changed-source");
      mkdirSync(otherSource);
      const isolated = selection(f, policy(ProviderConfigurationMode.ISOLATED, false, otherSource));
      const resumed = await turn(f, isolated, spec, "FIXTURE_DURABLE_CONFIGURATION_RESUMED");

      expect(first.bound).toBe(f.source);
      expect(resumed.bound).toBe(f.source);
      expect(resumed.request).toContain("FIXTURE_DURABLE_CONFIGURATION_FIRST");
      expect(transcriptPath(isolated.platformHome, spec.providerThreadId)).toBeUndefined();
      expect(readFileSync(transcriptPath(f.source, spec.providerThreadId)!, "utf8")).toContain(
        "FIXTURE_DURABLE_CONFIGURATION_RESUMED",
      );

      const fresh = thread(f);
      const current = await turn(f, isolated, fresh, "FIXTURE_DURABLE_CONFIGURATION_FRESH");
      expect(current.bound).toBe(isolated.platformHome);
      expect(current.request).not.toContain("FIXTURE_DURABLE_CONFIGURATION_FIRST");
      expect(transcriptPath(f.source, fresh.providerThreadId)).toBeUndefined();
      sourceUnchanged(f);
    } finally {
      await f.model.stop();
    }
  },
  60_000,
);
