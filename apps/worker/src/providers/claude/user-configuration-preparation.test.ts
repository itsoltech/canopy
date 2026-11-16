import { expect, test } from "bun:test";
import { query, type SDKUserMessage, type Settings } from "@anthropic-ai/claude-agent-sdk";
import { ProviderConfigurationMode } from "@canopy/contracts";
import { environmentBlock } from "@canopy/domain/agent-environment";
import { SKILL_FILE_BYTES, SKILL_TOTAL_BYTES } from "@canopy/domain/skill-artifact";
import { tempDirs } from "@canopy/testing";
import { AsyncChannel } from "@canopy/transport";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { startFakeModel } from "../../import/fixtures/fake-model.ts";
import type { ProfileUserConfiguration } from "../profiles.ts";
import { decodeJsonObject } from "../json.ts";
import { spawnClaude } from "./spawn.ts";
import { claudeInstructionSettings } from "./instructions.ts";
import { prepareClaudeUserConfiguration, type ClaudeUserConfiguration } from "./user-configuration.ts";

const temp = tempDirs();
const executable = Bun.which("claude");

function fixture() {
  const root = temp("canopy-claude-user-preparation-");
  const source = join(root, "source");
  const sessions = join(root, "sessions");
  const cwd = join(root, "repo");

  for (const path of [source, sessions, cwd]) mkdirSync(path);

  return { root, source, sessions, cwd };
}

function prepare(paths: ReturnType<typeof fixture>, changes: Partial<ProfileUserConfiguration> = {}) {
  return prepareClaudeUserConfiguration(
    {
      home: paths.sessions,
      sourceHome: paths.source,
      userConfiguration: {
        mode: ProviderConfigurationMode.LOCAL,
        sourcePath: "",
        instructions: true,
        skills: true,
        hooks: false,
        ...changes,
      },
    },
    paths.cwd,
  );
}

function environment(paths: ReturnType<typeof fixture>) {
  return {
    PATH: process.env["PATH"],
    HOME: paths.root,
    USERPROFILE: paths.root,
    CLAUDE_CONFIG_DIR: paths.sessions,
    ANTHROPIC_API_KEY: "synthetic-fixture",
    DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

async function inventory(paths: ReturnType<typeof fixture>, prepared: ClaudeUserConfiguration) {
  const input = new AsyncChannel<SDKUserMessage>();
  const abort = new AbortController();

  const q = query({
    prompt: input,
    options: {
      cwd: paths.cwd,
      pathToClaudeCodeExecutable: executable!,
      spawnClaudeCodeProcess: spawnClaude,
      env: environment(paths),
      settingSources: ["project", "local"],
      settings: await prepared.settingsFile(prepared.settings),
      plugins: prepared.plugins,
      strictMcpConfig: true,
      mcpServers: {},
      abortController: abort,
    },
  });

  const consumed = (async () => {
    for await (const _message of q) {
      /* Only initialization and MCP inventory are requested. */
    }
  })().catch(() => {});

  try {
    return { commands: await q.supportedCommands(), mcp: await q.mcpServerStatus() };
  } finally {
    input.close();
    abort.abort();
    await consumed;
  }
}

test.skipIf(!executable)(
  "native user skill wrapper discovers only opted-in skills and commands",
  async () => {
    const paths = fixture();
    const marker = join(paths.root, "unwanted-hook");

    mkdirSync(join(paths.source, "skills", "configuration-check"), { recursive: true });
    mkdirSync(join(paths.source, "commands"));
    mkdirSync(join(paths.source, "hooks"));
    writeFileSync(
      join(paths.source, "skills", "configuration-check", "SKILL.md"),
      "---\nname: configuration-check\ndescription: Inspect a synthetic configuration fixture\n---\nSay fixture.\n",
    );
    writeFileSync(
      join(paths.source, "commands", "legacy-check.md"),
      "---\ndescription: A fixture command\n---\nSay fixture.\n",
    );

    const hook = {
      type: "command",
      command: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'unwanted')", marker],
    };

    writeFileSync(
      join(paths.source, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [hook] }] } }),
    );
    writeFileSync(
      join(paths.source, ".mcp.json"),
      JSON.stringify({ mcpServers: { unwanted: { command: process.execPath, args: hook.args } } }),
    );
    const original = readdirSync(paths.source).sort();
    const enabled = await prepare(paths);
    const plugin = enabled.plugins[0];

    expect(plugin?.skipMcpDiscovery).toBe(true);
    expect(plugin).toBeDefined();

    try {
      expect(readdirSync(plugin!.path).sort()).toEqual([".claude-plugin", "commands", "skills"]);
      const listed = await inventory(paths, enabled);

      expect(listed.commands.map((command) => command.name)).toContain("canopy-user:configuration-check");
      expect(listed.commands.map((command) => command.name)).toContain("canopy-user:legacy-check");
      expect(listed.mcp).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await enabled.close();
    }

    expect(existsSync(plugin!.path)).toBe(false);
    const disabled = await prepare(paths, { skills: false });

    try {
      const listed = await inventory(paths, disabled);

      expect(listed.commands.map((command) => command.name)).not.toContain("canopy-user:configuration-check");
      expect(disabled.plugins).toEqual([]);
    } finally {
      await disabled.close();
    }

    expect(readdirSync(paths.source).sort()).toEqual(original);
  },
  30_000,
);

async function turn(
  paths: ReturnType<typeof fixture>,
  prepared: ClaudeUserConfiguration,
  overrides: { home?: string; settings?: Settings } = {},
) {
  const model = startFakeModel();
  const argv: string[] = [];
  const settingsPath = await prepared.settingsFile({ ...prepared.settings, ...overrides.settings });

  try {
    const q = query({
      prompt: "FIXTURE_USER_CONFIGURATION",
      options: {
        cwd: paths.cwd,
        pathToClaudeCodeExecutable: executable!,
        spawnClaudeCodeProcess: (options) => {
          argv.push(...options.args);

          return spawnClaude(options);
        },
        env: {
          ...environment(paths),
          CLAUDE_CONFIG_DIR: overrides.home ?? paths.sessions,
          ANTHROPIC_BASE_URL: model.url,
        },
        settingSources: ["project", "local"],
        settings: settingsPath,
        plugins: prepared.plugins,
        systemPrompt: { type: "preset", preset: "claude_code", append: prepared.instructions },
        strictMcpConfig: true,
        tools: [],
        maxTurns: 1,
      },
    });

    let completed = false;

    for await (const message of q) {
      if (message.type !== "result") continue;
      expect(message.subtype).toBe("success");
      completed = true;
    }

    expect(completed).toBe(true);

    const requests = model.requests
      .filter((request) => request.startsWith("{"))
      .map((request) => decodeJsonObject(JSON.parse(request)));

    return { argv: JSON.stringify(argv), requests: JSON.stringify(requests), settingsPath };
  } finally {
    await model.stop();
  }
}

test.skipIf(!executable)(
  "native selected hooks require opt-in and use private files while source instructions remain untouched",
  async () => {
    const paths = fixture();
    const marker = join(paths.root, "hook-ran");
    const hookValue = "SYNTHETIC_HOOK_PRIVATE_VALUE";

    const source = JSON.stringify({
      language: "English",
      env: { ANTHROPIC_API_KEY: "SYNTHETIC_AUTH_MUST_STAY_EXCLUDED" },
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: ["-e", `require('node:fs').writeFileSync(process.argv[1],'${hookValue}')`, marker],
              },
            ],
          },
        ],
      },
    });

    const instructions = `SELECTED_USER_INSTRUCTIONS\n${environmentBlock("MANAGED_BLOCK_MUST_NOT_DUPLICATE")}\nUSER_SUFFIX\n`;

    writeFileSync(join(paths.source, "settings.json"), source);
    writeFileSync(join(paths.source, "CLAUDE.md"), instructions);
    const disabled = await prepare(paths);

    try {
      const actual = await turn(paths, disabled);

      expect(existsSync(marker)).toBe(false);
      expect(actual.requests).toContain("SELECTED_USER_INSTRUCTIONS");
      expect(actual.requests).toContain("USER_SUFFIX");
      expect(actual.requests).not.toContain("MANAGED_BLOCK_MUST_NOT_DUPLICATE");
    } finally {
      await disabled.close();
    }

    const enabled = await prepare(paths, { hooks: true });
    let artifact = "";

    try {
      const actual = await turn(paths, enabled);

      artifact = actual.settingsPath;
      expect(readFileSync(marker, "utf8")).toBe(hookValue);
      expect(actual.argv).not.toContain(hookValue);
      expect(actual.argv).not.toContain("SYNTHETIC_AUTH_MUST_STAY_EXCLUDED");
      expect(readFileSync(artifact, "utf8")).toContain(hookValue);
      expect(readFileSync(artifact, "utf8")).not.toContain("SYNTHETIC_AUTH_MUST_STAY_EXCLUDED");

      if (process.platform !== "win32") {
        expect(statSync(artifact).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(artifact)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await enabled.close();
    }

    expect(existsSync(artifact)).toBe(false);
    expect(readFileSync(join(paths.source, "settings.json"), "utf8")).toBe(source);
    expect(readFileSync(join(paths.source, "CLAUDE.md"), "utf8")).toBe(instructions);
  },
  30_000,
);

test("isolated configuration does not inspect broken selected source files", async () => {
  const paths = fixture();

  writeFileSync(join(paths.source, "settings.json"), "invalid");
  writeFileSync(join(paths.source, "CLAUDE.md"), "invalid managed markers <!-- canopy:agent-environment:begin -->");
  const prepared = await prepare(paths, { mode: ProviderConfigurationMode.ISOLATED, hooks: true });

  try {
    expect(prepared.settings).toEqual({});
    expect(prepared.instructions).toBe("");
    expect(prepared.plugins).toEqual([]);
  } finally {
    await prepared.close();
  }
});

test("local configuration treats a missing source home as empty", async () => {
  const paths = fixture();

  rmSync(paths.source, { recursive: true });
  const prepared = await prepare(paths);

  try {
    expect(prepared.settings).toEqual({});
    expect(prepared.plugins).toEqual([]);
    expect(existsSync(paths.source)).toBe(false);
  } finally {
    await prepared.close();
  }
});

test("invalid hook definitions are ignored until explicit hook opt-in and fail without private contents", async () => {
  const paths = fixture();

  writeFileSync(
    join(paths.source, "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: { token: "PRIVATE_HOOK" } }] }] } }),
  );
  const disabled = await prepare(paths, { instructions: false, skills: false });

  try {
    expect(disabled.settings.hooks).toBeUndefined();
    await expect(prepare(paths, { instructions: false, skills: false, hooks: true })).rejects.toThrow(
      "Invalid Claude user hooks. Check the selected settings file.",
    );
  } finally {
    await disabled.close();
  }
});

test("user hooks cannot grant native tool permissions ahead of Canopy approvals", async () => {
  const paths = fixture();

  for (const event of ["PreToolUse", "PermissionRequest"]) {
    writeFileSync(
      join(paths.source, "settings.json"),
      JSON.stringify({
        hooks: { [event]: [{ hooks: [{ type: "command", command: "SYNTHETIC_PERMISSION_OVERRIDE" }] }] },
      }),
    );

    await expect(prepare(paths, { instructions: false, skills: false, hooks: true })).rejects.toThrow(
      "Claude user hooks cannot include PreToolUse or PermissionRequest because they can override Canopy approvals.",
    );
    const disabled = await prepare(paths, { instructions: false, skills: false });

    try {
      expect(disabled.settings.hooks).toBeUndefined();
    } finally {
      await disabled.close();
    }
  }
});

test("skill snapshots keep descriptive metadata and assets while removing runtime control frontmatter", async () => {
  const paths = fixture();
  const skill = join(paths.source, "skills", "snapshot-check");
  const commands = join(paths.source, "commands", "nested");

  mkdirSync(join(skill, "scripts"), { recursive: true });
  mkdirSync(commands, { recursive: true });

  const metadata = {
    name: "snapshot-check",
    description: "A synthetic snapshot fixture",
    "argument-hint": "[target]",
    "user-invocable": true,
    "disable-model-invocation": true,
    "allowed-tools": ["Bash(*)"],
    allowedTools: ["Write(*)"],
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "PRIVATE_HOOK_OVERRIDE" }] }] },
    context: "fork",
    agent: "general-purpose",
    model: "PRIVATE_MODEL_OVERRIDE",
    permissionMode: "bypassPermissions",
  };

  const body = "# Fixture\nRead scripts/check.sh and asset.bin.\nDynamic context: !`echo fixture`\n";
  const source = `---\n${Bun.YAML.stringify(metadata)}\n---\n${body}`;
  const command = "---\ndescription: Nested fixture command\nallowed-tools: Bash(*)\nhooks: {}\n---\nCommand body.\n";
  const asset = Buffer.from([0, 128, 255, 1]);

  writeFileSync(join(skill, "SKILL.md"), source);
  writeFileSync(join(skill, "asset.bin"), asset);
  writeFileSync(join(skill, "scripts", "check.sh"), "#!/bin/sh\necho fixture\n", { mode: 0o755 });
  writeFileSync(join(commands, "fixture.md"), command);
  const prepared = await prepare(paths);
  const plugin = prepared.plugins[0]!.path;

  try {
    const copiedSkill = join(plugin, "skills", "snapshot-check");
    const snapshot = readFileSync(join(copiedSkill, "SKILL.md"), "utf8");
    const frontmatter = /^---\n([^]*?)\n---\n/.exec(snapshot);

    expect(frontmatter).not.toBeNull();
    expect(decodeJsonObject(Bun.YAML.parse(frontmatter![1]!))).toEqual({
      name: metadata.name,
      description: metadata.description,
      "argument-hint": metadata["argument-hint"],
      "user-invocable": true,
      "disable-model-invocation": true,
    });
    expect(snapshot.slice(frontmatter![0].length)).toBe(body);
    expect(readFileSync(join(copiedSkill, "asset.bin"))).toEqual(asset);
    expect(lstatSync(copiedSkill).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(copiedSkill, "SKILL.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(plugin, "commands", "nested", "fixture.md"), "utf8")).not.toContain("allowed-tools");
    expect(readFileSync(join(plugin, "commands", "nested", "fixture.md"), "utf8")).not.toContain("hooks");
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toBe(source);
    expect(readFileSync(join(commands, "fixture.md"), "utf8")).toBe(command);

    if (process.platform !== "win32")
      expect(statSync(join(copiedSkill, "scripts", "check.sh")).mode & 0o777).toBe(0o700);

    writeFileSync(join(skill, "SKILL.md"), "UPDATED_SKILL_BODY\n");
    expect(readFileSync(join(copiedSkill, "SKILL.md"), "utf8")).toBe(snapshot);
    const next = await prepare(paths);

    try {
      expect(readFileSync(join(next.plugins[0]!.path, "skills", "snapshot-check", "SKILL.md"), "utf8")).toBe(
        "UPDATED_SKILL_BODY\n",
      );
    } finally {
      await next.close();
    }
  } finally {
    await prepared.close();
  }

  expect(existsSync(plugin)).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "symlinked skill libraries produce immutable sanitized regular snapshots",
  async () => {
    const paths = fixture();
    const skills = join(paths.source, "skills");
    const library = join(paths.root, "manager-library");
    const target = join(paths.root, ".agents", "skills", "linked-check");
    const metadata = join(paths.root, "linked-entry.md");
    const body = "LINKED_BODY\n";
    const source = `---\nname: linked-check\ndescription: Linked fixture\nallowed-tools: Bash(*)\nhooks: {}\n---\n${body}`;

    mkdirSync(target, { recursive: true });
    mkdirSync(library);
    writeFileSync(metadata, source);
    symlinkSync(metadata, join(target, "SKILL.md"), "file");
    symlinkSync(target, join(library, "linked-check"), "dir");
    symlinkSync(library, skills, "dir");
    const prepared = await prepare(paths);
    const snapshot = join(prepared.plugins[0]!.path, "skills", "linked-check", "SKILL.md");

    try {
      const initial = readFileSync(snapshot, "utf8");

      expect(initial).toContain(body);
      expect(initial).not.toContain("allowed-tools");
      expect(initial).not.toContain("hooks");
      expect(lstatSync(snapshot).isSymbolicLink()).toBe(false);
      expect(lstatSync(dirname(snapshot)).isSymbolicLink()).toBe(false);
      expect(readFileSync(metadata, "utf8")).toBe(source);

      if (executable) {
        const listed = await inventory(paths, prepared);

        expect(listed.commands.map((command) => command.name)).toContain("canopy-user:linked-check");
      }

      writeFileSync(metadata, source.replace(body, "UPDATED_LINKED_BODY\n"));
      expect(readFileSync(snapshot, "utf8")).toBe(initial);
      const next = await prepare(paths);

      try {
        const updated = readFileSync(join(next.plugins[0]!.path, "skills", "linked-check", "SKILL.md"), "utf8");

        expect(updated).toContain("UPDATED_LINKED_BODY");
        expect(updated).not.toContain("allowed-tools");
        expect(updated).not.toContain("hooks");
      } finally {
        await next.close();
      }
    } finally {
      await prepared.close();
    }

    expect(lstatSync(skills).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(target, "SKILL.md")).isSymbolicLink()).toBe(true);
    expect(existsSync(snapshot)).toBe(false);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "skill snapshots reject canonical directory cycles without exposing source paths or contents",
  async () => {
    const paths = fixture();
    const skills = join(paths.source, "skills");

    mkdirSync(join(skills, "nested"), { recursive: true });
    writeFileSync(join(skills, "PRIVATE_FILENAME.md"), "PRIVATE_CONTENT");
    symlinkSync(skills, join(skills, "nested", "back"), "dir");
    let message = "";

    try {
      await prepare(paths);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("Cannot import Claude skills and commands.");
    expect(message).not.toContain(paths.source);
    expect(message).not.toContain("PRIVATE_FILENAME");
    expect(message).not.toContain("PRIVATE_CONTENT");
    expect(readFileSync(join(skills, "PRIVATE_FILENAME.md"), "utf8")).toBe("PRIVATE_CONTENT");
  },
);

test("skill snapshots reject oversized individual files and combined trees", async () => {
  const paths = fixture();
  const skills = join(paths.source, "skills");
  const commands = join(paths.source, "commands");
  const oversized = join(skills, "asset.bin");

  mkdirSync(skills);
  mkdirSync(commands);
  writeFileSync(oversized, Buffer.alloc(SKILL_FILE_BYTES + 1));
  await expect(prepare(paths)).rejects.toThrow("at most 1 MiB per file");
  const asset = Buffer.alloc(SKILL_FILE_BYTES);

  writeFileSync(oversized, asset);
  writeFileSync(join(commands, "second.bin"), asset);
  const accepted = await prepare(paths);

  try {
    expect(readFileSync(join(accepted.plugins[0]!.path, "commands", "second.bin"))).toEqual(asset);
  } finally {
    await accepted.close();
  }

  for (let index = 1; index < SKILL_TOTAL_BYTES / SKILL_FILE_BYTES; index++)
    writeFileSync(join(commands, `extra-${index}.bin`), asset);

  await expect(prepare(paths)).rejects.toThrow("25 MiB in total");
  expect(statSync(oversized).size).toBe(SKILL_FILE_BYTES);
});

test.skipIf(process.platform === "win32" || !Bun.which("mkfifo"))(
  "skill snapshots reject a non-regular source entry without opening it",
  async () => {
    const paths = fixture();
    const skills = join(paths.source, "skills");

    mkdirSync(skills);
    const fifo = join(skills, "pipe");

    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    await expect(prepare(paths)).rejects.toThrow("Cannot import Claude skills and commands.");
    expect(lstatSync(fifo).isFIFO()).toBe(true);
  },
);

test.skipIf(!executable)(
  "shared-home instruction opt-in injects CLAUDE.md while global rules stay excluded",
  async () => {
    const paths = fixture();

    mkdirSync(join(paths.source, "rules"));
    mkdirSync(join(paths.cwd, ".claude", "rules"), { recursive: true });
    writeFileSync(join(paths.source, "CLAUDE.md"), "SHARED_GLOBAL_MEMORY_MARKER\n");
    writeFileSync(join(paths.source, "rules", "global.md"), "SHARED_GLOBAL_RULE_MARKER\n");
    writeFileSync(join(paths.cwd, ".claude", "rules", "project.md"), "PROJECT_RULE_MUST_STILL_LOAD\n");
    const disabled = await prepare(paths, { mode: ProviderConfigurationMode.SHARED, instructions: false });

    try {
      const exclusions = await claudeInstructionSettings(paths.cwd, false, paths.source, environment(paths));
      const filtered = await turn(paths, disabled, { home: paths.source, settings: exclusions });

      expect(filtered.requests).not.toContain("SHARED_GLOBAL_MEMORY_MARKER");
      expect(filtered.requests).not.toContain("SHARED_GLOBAL_RULE_MARKER");
      expect(filtered.requests).toContain("PROJECT_RULE_MUST_STILL_LOAD");
      const selected = await prepare(paths, { mode: ProviderConfigurationMode.SHARED });

      try {
        const explicit = await turn(paths, selected, { home: paths.source, settings: exclusions });

        expect(explicit.requests).toContain("SHARED_GLOBAL_MEMORY_MARKER");
        expect(explicit.requests).not.toContain("SHARED_GLOBAL_RULE_MARKER");
        expect(explicit.requests).toContain("PROJECT_RULE_MUST_STILL_LOAD");
      } finally {
        await selected.close();
      }
    } finally {
      await disabled.close();
    }
  },
  30_000,
);
