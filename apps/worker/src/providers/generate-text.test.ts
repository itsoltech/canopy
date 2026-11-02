import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@open-agents/testing";
import { codexTextCatalog, codexTextOverrides } from "./generate-text.ts";
import { generateCodexText } from "./generate-text.ts";
import { codexAppServerLaunch } from "./codex/launch.ts";
import { resolveProfiles } from "./profiles.ts";

const dir = tempDir("oa-text-config-");
test.skipIf(!Bun.which("codex"))("the pinned Codex accepts the isolated no-tools generation configuration", () => {
  const catalog = join(dir, "models.json");
  writeFileSync(catalog, JSON.stringify(codexTextCatalog("gpt-6.1-sol", "low")));
  const result = Bun.spawnSync(["codex", "app-server", "--print-startup-config", ...codexTextOverrides(catalog)], { env: { ...process.env, CODEX_HOME: dir } });
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain('"error"');
  expect(result.exitCode).toBe(0);
});

test.skipIf(!Bun.which("codex"))("Codex sends no tool schemas to the model and cancels without leaving a session", async () => {
  const request = Promise.withResolvers<{ tools?: unknown[] }>();
  const abort = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (incoming) => {
      if (incoming.method === "POST" && new URL(incoming.url).pathname.endsWith("/responses")) request.resolve(await incoming.json() as { tools?: unknown[] });
      return Response.json({ error: { message: "fixture refuses inference", type: "invalid_request_error" } }, { status: 400 });
    },
  });
  const profile = resolveProfiles([{ kind: "cliproxyapi", id: "fixture", baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "test", providers: ["codex"] }]).find((p) => p.config.id === "fixture")!.resolved!;
  const generation = generateCodexText({ model: "gpt-6.1-sol", effort: "low", prompt: "A short title" }, {
    launch: codexAppServerLaunch([profile], process.env, "codex", undefined, dir), profile, dataDir: dir, clientVersion: "test",
  }, abort.signal);
  // Observe rejection immediately as well as awaiting it during cleanup.
  const ended = generation.catch(() => undefined);
  const timer = setTimeout(() => { abort.abort(); request.reject(new Error("Codex did not send an inference request")); }, 10_000);
  try {
    const body = await request.promise;
    expect(body.tools ?? []).toEqual([]);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await ended;
    await server.stop(true);
  }
}, 15_000);
