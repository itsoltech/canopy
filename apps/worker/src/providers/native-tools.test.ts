import { describe, expect, test } from "bun:test";
import { codexAppServerLaunch } from "./codex/launch.ts";
import { claudeNativeToolOptions, codexNativeToolOverrides, DEFAULT_NATIVE_TOOL_POLICY } from "./native-tools.ts";

describe("native provider tools", () => {
  test("Claude: subagent and scheduling tools are disabled by default, each category can opt back in", () => {
    expect(claudeNativeToolOptions(DEFAULT_NATIVE_TOOL_POLICY).disallowedTools).toEqual([
      "Agent", "Task", "Workflow", "ListAgents", "SendMessage", "SubagentHandback",
      "ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "RemoteTrigger",
    ]);
    expect(claudeNativeToolOptions({ nativeSubagents: true, nativeScheduling: false }).disallowedTools).not.toContain("Agent");
    expect(claudeNativeToolOptions({ nativeSubagents: true, nativeScheduling: true }).disallowedTools).toEqual([]);
  });

  test("Claude: every disabled name is a real built-in tool of the pinned SDK", async () => {
    const { BUILTIN_TOOL_NAMES } = await import("@anthropic-ai/claude-agent-sdk");
    const disabled = claudeNativeToolOptions(DEFAULT_NATIVE_TOOL_POLICY).disallowedTools;
    // Task is the legacy name of Agent; kept so older CLIs are covered as well.
    expect(disabled.filter((name) => name !== "Task" && !BUILTIN_TOOL_NAMES.includes(name as never))).toEqual([]);
  });

  test("Codex: every feature is pinned explicitly", () => {
    expect(codexNativeToolOverrides(DEFAULT_NATIVE_TOOL_POLICY)).toEqual([
      "-c", "features.multi_agent=false",
      "-c", "features.multi_agent_v2=false",
      "-c", "features.in_app_local_automation=false",
      "-c", "features.sleep_tool=false",
      "-c", "features.apps=false",
    ]);
  });

  // --print-startup-config does not reject unknown feature keys, so check the effective state instead:
  // `codex features list` reports what the same overrides resolve to (and would not list a misspelled feature).
  const codexBin = Bun.which("codex");
  test.skipIf(!codexBin)("the real codex CLI reports all of them as disabled", () => {
    const launch = codexAppServerLaunch([], process.env, codexBin!);
    const overrides = launch.command.slice(2);
    const result = Bun.spawnSync([codexBin!, ...overrides, "features", "list"], { env: launch.env });
    expect(result.exitCode).toBe(0);
    const wanted = new Set(["multi_agent", "multi_agent_v2", "in_app_local_automation", "sleep_tool", "apps"]);
    const state = Object.fromEntries(
      result.stdout
        .toString()
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((cols) => wanted.has(cols[0] ?? ""))
        .map((cols) => [cols[0], cols.at(-1)]),
    );
    expect(state).toEqual({ multi_agent: "false", multi_agent_v2: "false", in_app_local_automation: "false", sleep_tool: "false", apps: "false" });
  });
});
