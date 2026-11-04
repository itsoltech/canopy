import { expect, test } from "bun:test";
import { resolve } from "node:path";

/** Harnesses own inference. Model discovery and test-owned HTTP fixtures are permitted. */
test("production sources never invoke LLM HTTP endpoints or provider HTTP SDKs", async () => {
  const root = resolve(import.meta.dir, "..");
  const violations: string[] = [];

  const inference =
    /\/v1\/(?:messages|responses|chat\/completions)\b|\/chat\/completions\b|fetch\([^\n]*(?:\/messages|\/responses)\b|(?:from\s*|import\s*\(|require\s*\()\s*["'](?:openai|@anthropic-ai\/sdk|@ai-sdk\/[^"']+|ai)["']|\.(?:chat\.completions|messages|responses)\.(?:create|stream)\s*\(/;

  for await (const path of new Bun.Glob("{apps,packages}/**/src/**/*.{ts,tsx,js,mjs,svelte}").scan({ cwd: root })) {
    if (/\.(?:test|spec)\.[^.]+$|\/(?:fixtures|__tests__|gen)\//.test(path)) continue;
    const lines = (await Bun.file(resolve(root, path)).text()).split("\n");

    for (const [index, line] of lines.entries()) {
      if (/^\s*(?:\/\/|\*|import type\b)/.test(line)) continue;

      if (inference.test(line)) violations.push(`${path}:${index + 1}`);
    }
  }

  expect(violations, "Route inference through the official worker harness; no source exceptions").toEqual([]);
});
