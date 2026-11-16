import { expect, test } from "bun:test";
import { query, type Settings } from "@anthropic-ai/claude-agent-sdk";
import { tempDirs } from "@canopy/testing";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeModel } from "../../import/fixtures/fake-model.ts";
import { decodeJsonObject } from "../json.ts";
import { spawnClaude } from "./spawn.ts";
import { readClaudePreferences } from "./user-preferences.ts";

const temp = tempDirs();
const executable = Bun.which("claude");
const nativeTest = test.skipIf(!executable);

function fixture() {
  const root = temp("canopy-claude-preferences-");
  const source = join(root, "source");
  const sessions = join(root, "sessions");
  const cwd = join(root, "repo");

  for (const directory of [source, sessions, join(cwd, ".claude")]) mkdirSync(directory, { recursive: true });
  expect(Bun.spawnSync(["git", "init", "--quiet", cwd]).exitCode).toBe(0);

  return { root, source, sessions, cwd };
}

/** Real SDK/native requests terminate at a loopback model fixture; there is no external inference or login. */
async function capture(paths: ReturnType<typeof fixture>, settings: Settings, nativeUserSource = false) {
  const model = startFakeModel();
  const argv: string[] = [];
  let completed = false;

  try {
    const q = query({
      prompt: "FIXTURE_PREFERENCES",
      options: {
        cwd: paths.cwd,
        pathToClaudeCodeExecutable: executable!,
        spawnClaudeCodeProcess: (options) => {
          argv.push(...options.args);

          return spawnClaude(options);
        },
        env: {
          PATH: process.env["PATH"],
          HOME: paths.root,
          USERPROFILE: paths.root,
          CLAUDE_CONFIG_DIR: nativeUserSource ? paths.source : paths.sessions,
          ANTHROPIC_BASE_URL: model.url,
          ANTHROPIC_API_KEY: "synthetic-fixture",
          DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        settingSources: nativeUserSource ? ["user", "project", "local"] : ["project", "local"],
        strictMcpConfig: true,
        settings,
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: ["Bash"],
        maxTurns: 1,
      },
    });

    for await (const message of q) {
      if (message.type !== "result") continue;
      expect(message.subtype).toBe("success");
      completed = true;
    }

    expect(completed).toBe(true);

    const messages = model.requests
      .filter((request) => request.startsWith("{"))
      .map((request) => decodeJsonObject(JSON.parse(request))["messages"]);

    expect(messages.length).toBeGreaterThan(0);

    return { messages: JSON.stringify(messages), argv: JSON.stringify(argv) };
  } finally {
    await model.stop();
  }
}

nativeTest(
  "selected global coauthor preferences change the native attribution reminder",
  async () => {
    const paths = fixture();

    writeFileSync(join(paths.source, "settings.json"), JSON.stringify({ includeCoAuthoredBy: false }));
    const disabled = await capture(paths, await readClaudePreferences(paths.source, paths.cwd));

    expect(disabled.messages).not.toContain("Co-Authored-By:");
    writeFileSync(join(paths.source, "settings.json"), "{}");
    const defaults = await capture(paths, await readClaudePreferences(paths.source, paths.cwd));

    expect(defaults.messages).toContain("Co-Authored-By:");
    writeFileSync(join(paths.source, "settings.json"), JSON.stringify({ attribution: false }));
    const currentSetting = await capture(paths, await readClaudePreferences(paths.source, paths.cwd));

    expect(currentSetting.messages).not.toContain("Co-Authored-By:");
  },
  30_000,
);

nativeTest(
  "native attribution respects project and local precedence without exposing blocked user configuration",
  async () => {
    const paths = fixture();
    const secret = "SYNTHETIC_PRIVATE_CONFIGURATION";

    const source = JSON.stringify({
      attribution: { commit: "USER_COMMIT", pr: "USER_PR", sessionUrl: false, privateValue: secret },
      language: "Polish",
      spinnerVerbs: { mode: "replace", verbs: ["User", "Shared"] },
      modelSettings: { opus: { effortLevel: "medium", apiKey: secret } },
      env: { ANTHROPIC_BASE_URL: secret, ANTHROPIC_API_KEY: secret },
      apiKeyHelper: secret,
      processWrapper: secret,
      permissions: { defaultMode: "bypassPermissions", allow: ["Bash(*)"] },
      sandbox: { enabled: false },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: secret }] }] },
      enabledPlugins: { [secret]: true },
      managedMcpServers: { private: { command: secret } },
    });

    writeFileSync(join(paths.source, "settings.json"), source);
    writeFileSync(
      join(paths.cwd, ".claude", "settings.json"),
      JSON.stringify({
        attribution: { commit: "PROJECT_COMMIT" },
        language: "English",
        spinnerVerbs: { mode: "replace", verbs: ["Project", "Shared"] },
      }),
    );
    writeFileSync(
      join(paths.cwd, ".claude", "settings.local.json"),
      JSON.stringify({ attribution: { pr: "LOCAL_PR" }, spinnerVerbs: { mode: "replace", verbs: ["Local"] } }),
    );
    const preferences = await readClaudePreferences(paths.source, paths.cwd);
    const actual = await capture(paths, preferences);

    expect(actual.messages).toContain("PROJECT_COMMIT");
    expect(actual.messages).toContain("LOCAL_PR");
    expect(actual.messages).not.toContain("USER_COMMIT");
    expect(actual.messages).not.toContain("USER_PR");
    expect(actual.messages).not.toContain(secret);
    expect(actual.argv).not.toContain(secret);
    expect(preferences.language).toBe("English");
    expect(preferences.spinnerVerbs?.verbs).toEqual(["User", "Shared", "Project", "Local"]);
    expect(preferences.modelSettings).toEqual({ opus: { effortLevel: "medium" } });
    expect(readFileSync(join(paths.source, "settings.json"), "utf8")).toBe(source);
  },
  30_000,
);

nativeTest.skipIf(process.platform === "win32")(
  "nested-cwd preferences match native canonical local settings precedence",
  async () => {
    const paths = fixture();
    const nested = join(paths.cwd, "nested");

    mkdirSync(join(nested, ".claude"), { recursive: true });
    writeFileSync(
      join(paths.source, "settings.json"),
      JSON.stringify({ attribution: { commit: "USER_COMMIT", pr: "USER_PR" } }),
    );
    writeFileSync(
      join(nested, ".claude", "settings.json"),
      JSON.stringify({ attribution: { commit: "NESTED_PROJECT_COMMIT" } }),
    );
    writeFileSync(
      join(nested, ".claude", "settings.local.json"),
      JSON.stringify({ attribution: { pr: "NESTED_LOCAL_PR" } }),
    );
    writeFileSync(
      join(paths.cwd, ".claude", "settings.local.json"),
      JSON.stringify({ attribution: { pr: "ROOT_LOCAL_PR" } }),
    );
    const native = await capture({ ...paths, cwd: nested }, {}, true);
    const preferences = await readClaudePreferences(paths.source, nested);
    const inherited = await capture({ ...paths, cwd: nested }, preferences);

    for (const actual of [native, inherited]) {
      expect(actual.messages).toContain("NESTED_PROJECT_COMMIT");
      expect(actual.messages).toContain("ROOT_LOCAL_PR");
      expect(actual.messages).not.toContain("NESTED_LOCAL_PR");
      expect(actual.messages).not.toContain("USER_COMMIT");
      expect(actual.messages).not.toContain("USER_PR");
    }
  },
  30_000,
);

test("unreadable and malformed preferences report no source paths or private contents", async () => {
  const paths = fixture();
  const file = join(paths.source, "settings.json");

  for (const content of ["SYNTHETIC_PRIVATE_CONFIGURATION", '{"attribution":{"commit":42}}', " ".repeat(1_048_577)]) {
    writeFileSync(file, content);
    let message = "";

    try {
      await readClaudePreferences(paths.source, paths.cwd);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("Invalid Claude preferences");
    expect(message).not.toContain(paths.source);
    expect(message).not.toContain("SYNTHETIC_PRIVATE_CONFIGURATION");
  }
});

test.skipIf(process.platform === "win32")(
  "selected symlink preferences are read without changing global environment",
  async () => {
    const first = fixture();
    const second = fixture();
    const target = join(first.root, "preferences.json");
    const before = process.env["CLAUDE_CONFIG_DIR"];

    writeFileSync(target, JSON.stringify({ includeCoAuthoredBy: false }));
    symlinkSync(target, join(first.source, "settings.json"));
    writeFileSync(join(second.source, "settings.json"), JSON.stringify({ attribution: { commit: "SECOND" } }));

    const [one, two] = await Promise.all([
      readClaudePreferences(first.source, first.cwd),
      readClaudePreferences(second.source, second.cwd),
    ]);

    expect(one.includeCoAuthoredBy).toBe(false);
    expect(two.attribution).toEqual({ commit: "SECOND" });
    expect(process.env["CLAUDE_CONFIG_DIR"]).toBe(before);
    expect(readFileSync(target, "utf8")).toBe('{"includeCoAuthoredBy":false}');
  },
);
