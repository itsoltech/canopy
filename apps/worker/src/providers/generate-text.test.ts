import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { codexTextCatalog, codexTextOverrides } from "./generate-text.ts";
import { generateClaudeText, generateCodexText } from "./generate-text.ts";
import { claudeProfileOptions } from "./claude/profile.ts";
import { codexAppServerLaunch } from "./codex/launch.ts";
import { resolveProfiles } from "./profiles.ts";

const dir = tempDir("canopy-text-config-");

test("Claude generation reports requested default and explicitly disables inherited fast mode", async () => {
  const consumed: import("./token-usage.ts").ConsumedUsage[] = [];
  expect(
    await generateClaudeText(
      { model: "fixture", effort: "", prompt: "Say Done", onConsumedUsage: (usage) => consumed.push(usage) },
      {
        cwd: dir,
        pathToClaudeCodeExecutable: join(import.meta.dir, "fixtures/service-tiers.ts"),
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir, TIER_TRACE: join(dir, "generation-tiers.jsonl") },
      },
      AbortSignal.timeout(5000),
    ),
  ).toBe("Done");
  expect(consumed.at(-1)).toMatchObject({ requestedServiceTier: "default", inputTokens: 1n, reportedCostUsd: 0 });
  expect(readFileSync(join(dir, "generation-tiers.jsonl"), "utf8")).toContain('"fastMode":false');
});

test("Claude refuses a missing installed CLI instead of using the SDK's optional bundled binary", async () => {
  await expect(
    generateClaudeText(
      { model: "", effort: "", prompt: "unused" },
      { cwd: dir, env: { PATH: "", HOME: dir } },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Claude Code is not installed on this computer");
});

test.skipIf(!Bun.which("codex"))("the pinned Codex accepts the isolated no-tools generation configuration", () => {
  const catalog = join(dir, "models.json");
  writeFileSync(catalog, JSON.stringify(codexTextCatalog("gpt-6.1-sol", "low")));

  const result = Bun.spawnSync(["codex", "app-server", "--print-startup-config", ...codexTextOverrides(catalog)], {
    env: { ...process.env, CODEX_HOME: dir },
  });

  expect(result.stdout.toString() + result.stderr.toString()).not.toContain('"error"');
  expect(result.exitCode).toBe(0);
});

test.skipIf(!Bun.which("codex"))(
  "Codex sends no tool schemas to the model and cancels without leaving a session",
  async () => {
    const request = Promise.withResolvers<{ tools?: unknown[] }>();
    const abort = new AbortController();

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (incoming) => {
        if (incoming.method === "POST" && new URL(incoming.url).pathname.endsWith("/responses"))
          request.resolve((await incoming.json()) as { tools?: unknown[] });

        return Response.json(
          { error: { message: "fixture refuses inference", type: "invalid_request_error" } },
          { status: 400 },
        );
      },
    });

    const profile = resolveProfiles([
      {
        kind: "cliproxyapi",
        id: "fixture",
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "test",
        providers: ["codex"],
      },
    ]).find((p) => p.config.id === "fixture")!.resolved!;

    const generation = generateCodexText(
      { model: "gpt-6.1-sol", effort: "low", prompt: "Run ls in your own working directory. Use a shell tool now." },
      {
        launch: codexAppServerLaunch([profile], process.env, "codex", undefined, dir),
        profile,
        dataDir: dir,
        clientVersion: "test",
      },
      abort.signal,
    );

    // Observe rejection immediately as well as awaiting it during cleanup.
    const ended = generation.catch(() => undefined);

    const timer = setTimeout(() => {
      abort.abort();
      request.reject(new Error("Codex did not send an inference request"));
    }, 10_000);

    try {
      const body = await request.promise;
      expect(body.tools ?? []).toEqual([]);
    } finally {
      clearTimeout(timer);
      abort.abort();
      await ended;
      await server.stop(true);
    }
  },
  15_000,
);

test.skipIf(!Bun.which("claude"))(
  "Claude sends no tool schemas even when asked to run ls",
  async () => {
    const request = Promise.withResolvers<{ tools?: unknown[] }>();
    const abort = new AbortController();

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (incoming) => {
        if (incoming.method === "POST" && new URL(incoming.url).pathname.endsWith("/messages"))
          request.resolve((await incoming.json()) as { tools?: unknown[] });

        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: "fixture refuses inference" } },
          { status: 400 },
        );
      },
    });

    const profile = resolveProfiles([
      { kind: "cliproxyapi", id: "fixture", baseUrl: server.url.toString(), apiKey: "test", providers: ["claude"] },
    ]).find((p) => p.config.id === "fixture")!.resolved!;

    const generation = generateClaudeText(
      { model: "claude-haiku-5-5", effort: "low", prompt: "Run ls in your own working directory. Use Bash now." },
      {
        cwd: dir,
        ...claudeProfileOptions(profile, { ...process.env, CLAUDE_CONFIG_DIR: dir }),
      },
      abort.signal,
    );

    const ended = generation.catch(() => undefined);

    const timer = setTimeout(() => {
      abort.abort();
      request.reject(new Error("Claude did not send an inference request"));
    }, 15_000);

    try {
      expect((await request.promise).tools ?? []).toEqual([]);
    } finally {
      clearTimeout(timer);
      abort.abort();
      await ended;
      await server.stop(true);
    }
  },
  20_000,
);

test.skipIf(!Bun.which("codex"))(
  "Codex generation reports real response usage with cached input and reasoning as subsets",
  async () => {
    const output = [
      {
        type: "message",
        id: "answer",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Done", annotations: [] }],
      },
    ];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          [
            { type: "response.output_item.done", output_index: 0, item: output[0] },
            {
              type: "response.completed",
              response: {
                id: "response",
                status: "completed",
                output,
                usage: {
                  input_tokens: 11,
                  output_tokens: 7,
                  total_tokens: 18,
                  input_tokens_details: { cached_tokens: 3 },
                  output_tokens_details: { reasoning_tokens: 2 },
                },
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });

    const profile = resolveProfiles([
      { kind: "cliproxyapi", id: "fixture", baseUrl: server.url.toString(), apiKey: "test", providers: ["codex"] },
    ]).find((entry) => entry.config.id === "fixture")!.resolved!;

    const consumed: import("./token-usage.ts").ConsumedUsage[] = [];

    try {
      expect(
        await generateCodexText(
          { model: "gpt-6.1-sol", effort: "low", prompt: "Say Done", onConsumedUsage: (usage) => consumed.push(usage) },
          {
            launch: codexAppServerLaunch([profile], process.env, "codex", undefined, dir),
            profile,
            dataDir: dir,
            clientVersion: "test",
          },
          AbortSignal.timeout(10000),
        ),
      ).toBe("Done");
      expect(consumed.at(-1)).toMatchObject({
        model: "gpt-6.1-sol",
        requestedServiceTier: "default",
        inputTokens: 11n,
        outputTokens: 7n,
        cachedInputTokens: 3n,
        reasoningOutputTokens: 2n,
      });
      expect(consumed.at(-1)?.reportedCostUsd).toBeUndefined();
    } finally {
      server.stop(true);
    }
  },
  15000,
);
