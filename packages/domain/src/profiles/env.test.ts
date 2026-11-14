import { describe, expect, test } from "bun:test";
import { envListProblems, envNameProblem } from "./env.ts";

describe("profile env rules", () => {
  test("accepts ordinary names", () => {
    expect(envNameProblem("native", "PROFILE_PROBE")).toBeUndefined();
    expect(envNameProblem("native", "_private1")).toBeUndefined();
    expect(envNameProblem("native", "ANTHROPIC_API_KEY")).toBeUndefined();
  });

  test("rejects what the worker controls, case-insensitively", () => {
    for (const name of [
      "HOME",
      "path",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      "codex_home",
      "USERPROFILE",
      "CLAUDE_CODE_ENTRYPOINT",
    ]) {
      expect(envNameProblem("native", name)).toContain("Change the home or CLI path in Runtime instead.");
    }

    expect(envNameProblem("native", "CANOPY_X_API_KEY")).toContain("reserved");
  });

  test("an endpoint profile owns its endpoint and key variables", () => {
    expect(envNameProblem("endpoint", "ANTHROPIC_BASE_URL")).toContain("Pick or edit a proxy in Connection instead.");
    expect(envNameProblem("endpoint", "anthropic_api_key")).toContain("Pick or edit a proxy in Connection instead.");
    expect(envNameProblem("native", "ANTHROPIC_BASE_URL")).toBeUndefined();
  });

  test("rejects malformed names", () => {
    expect(envNameProblem("native", "")).toBe("Enter a variable name.");
    expect(envNameProblem("native", "1ABC")).toContain("letters");
    expect(envNameProblem("native", "A-B")).toContain("letters");
    expect(envNameProblem("native", "A=B")).toContain("letters");
  });

  test("list: duplicates (case-insensitive), sizes, NUL", () => {
    const problems = envListProblems("native", [
      { name: "A", value: "1" },
      { name: "a", value: "2" },
      { name: "B", value: "x".repeat(40_000) },
      { name: "C", value: "a\0b" },
    ]);

    expect(problems.map((p) => p.index)).toEqual([1, 2, 3]);
  });
});
