import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfiguredEffort, codexConfiguredEffort, pickDefaultEffort, readClaudeUserSettings, readCodexConfiguredEffort } from "./default-effort.ts";

describe("configured default effort", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("only a level the model offers: configured, else the model's own, else none", () => {
    expect(pickDefaultEffort(["low", "medium", "high"], "high", "medium")).toBe("high");
    expect(pickDefaultEffort(["low", "medium", "high"], "xhigh", "medium")).toBe("medium");
    expect(pickDefaultEffort(["low", "medium"], undefined, "medium")).toBe("medium");
    expect(pickDefaultEffort([], "high", "medium")).toBeUndefined();
    expect(pickDefaultEffort(["low"], undefined, "high")).toBeUndefined();
  });

  test("Codex config.toml: the chosen profile's model_reasoning_effort, else the top-level one", () => {
    expect(codexConfiguredEffort('model_reasoning_effort = "high"\n')).toBe("high");
    expect(
      codexConfiguredEffort(`model_reasoning_effort = "low"
profile = "deep"

[profiles.deep]
model_reasoning_effort = "xhigh"

[profiles.quick]
model_reasoning_effort = "minimal"
`),
    ).toBe("xhigh");
    // A profile without its own effort keeps the top-level one; an unknown profile too.
    expect(codexConfiguredEffort('model_reasoning_effort = "medium"\nprofile = "quick"\n[profiles.quick]\nmodel = "gpt-6.1-sol"\n')).toBe("medium");
    expect(codexConfiguredEffort('model_reasoning_effort = "medium"\nprofile = "missing"\n')).toBe("medium");
    // Settings that only look alike do not count.
    expect(codexConfiguredEffort('plan_mode_reasoning_effort = "high"\n[model_providers.proxy]\nmodel_reasoning_effort = "low"\n')).toBeUndefined();
    expect(codexConfiguredEffort("model_reasoning_effort = [broken")).toBeUndefined();
  });

  test("Claude: CLAUDE_CODE_EFFORT_LEVEL, then modelSettings.<model>.effortLevel, then effortLevel", () => {
    const settings = { effortLevel: "medium", modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" }, "claude-sonnet-4-5": { effortLevel: "low" }, "claude-haiku-5-5": { maxEffortLevel: "high" } } };
    expect(claudeConfiguredEffort(settings, {}, ["opus", "claude-opus-5-5"])).toBe("xhigh");
    // The key matches dated and [1m] spellings of the model.
    expect(claudeConfiguredEffort(settings, {}, ["claude-sonnet-4-5-20250929"])).toBe("low");
    expect(claudeConfiguredEffort(settings, {}, ["claude-sonnet-4-5[1m]"])).toBe("low");
    expect(claudeConfiguredEffort(settings, {}, ["claude-haiku-5-5"])).toBe("medium");
    expect(claudeConfiguredEffort(settings, { CLAUDE_CODE_EFFORT_LEVEL: "MAX" }, ["claude-opus-5-5"])).toBe("max");
    // auto / unset: Claude Code sends the model's own default, which it does not report.
    expect(claudeConfiguredEffort(settings, { CLAUDE_CODE_EFFORT_LEVEL: "auto" }, ["claude-opus-5-5"])).toBeUndefined();
    expect(claudeConfiguredEffort({}, {}, ["claude-opus-5-5"])).toBeUndefined();
    expect(claudeConfiguredEffort(undefined, {}, [])).toBeUndefined();
  });

  test("the files are read from the given homes; missing or broken files mean no default", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "oa-effort-codex-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "oa-effort-claude-"));
    dirs.push(codexHome, claudeHome);
    expect(readCodexConfiguredEffort(codexHome)).toBeUndefined();
    expect(readClaudeUserSettings(claudeHome)).toBeUndefined();
    writeFileSync(join(codexHome, "config.toml"), 'model_reasoning_effort = "high"\n');
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ effortLevel: "low" }));
    expect(readCodexConfiguredEffort(codexHome)).toBe("high");
    expect(claudeConfiguredEffort(readClaudeUserSettings(claudeHome), {}, ["claude-opus-5-5"])).toBe("low");
    writeFileSync(join(claudeHome, "settings.json"), "{ // comments are not JSON");
    expect(readClaudeUserSettings(claudeHome)).toBeUndefined();
  });
});
