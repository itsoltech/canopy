/**
 * Live tests against the real `codex app-server` and real models. Opt-in: OA_LIVE=1.
 * They use the account / proxy configured on this machine and cost a few tokens.
 * Notification streams are recorded to $OA_LIVE_RECORD_DIR (default /tmp/oa-codex-recordings)
 * as raw material for the event mapping.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_PROTOCOL_VERSION, type ServerNotification } from "@open-agents/codex-protocol";
import { Effect, Fiber, Stream } from "effect";
import { resolveProfiles } from "../profiles.ts";
import { CodexAppServer } from "./app-server.ts";
import { prepareCodexHome } from "./home.ts";
import { codexAppServerLaunch, codexThreadProvider } from "./launch.ts";

const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];
const recordDir = process.env["OA_LIVE_RECORD_DIR"] ?? "/tmp/oa-codex-recordings";
const workDir = mkdtempSync(join(tmpdir(), "oa-codex-live-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const serverRequests: { method: string }[] = [];

function layerFor(profiles: Parameters<typeof codexAppServerLaunch>[0], codexHome?: string) {
  return CodexAppServer.layer({
    launch: codexAppServerLaunch(profiles, process.env, "codex", undefined, codexHome),
    clientVersion: "0.0.0-live",
    onServerRequest: async (request) => {
      serverRequests.push({ method: request.method });
      // Tests use approvalPolicy "never"; anything that still asks is declined.
      return request.method.endsWith("requestApproval") ? { decision: "decline" } : {};
    },
  });
}

/** Runs one turn and collects every notification of the thread until turn/completed. */
const runTurn = (threadId: string, text: string) =>
  Effect.gen(function* () {
    const codex = yield* CodexAppServer;
    const collected: ServerNotification[] = [];
    const collector = yield* codex.notifications.pipe(
      Stream.filter((n) => (n.params as { threadId?: string } | undefined)?.threadId === threadId),
      Stream.takeUntil((n) => n.method === "turn/completed"),
      Stream.runForEach((n) => Effect.sync(() => collected.push(n))),
      Effect.forkChild,
    );
    yield* Effect.sleep("50 millis"); // let the subscription start before the turn
    yield* codex.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
    yield* Fiber.join(collector).pipe(Effect.timeout("180 seconds"));
    return collected;
  });

function record(name: string, notifications: readonly ServerNotification[]): void {
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(join(recordDir, `${name}.jsonl`), notifications.map((n) => JSON.stringify(n)).join("\n") + "\n");
}

function agentText(notifications: readonly ServerNotification[]): string {
  return notifications
    .filter((n) => n.method === "item/completed")
    .map((n) => (n.params as { item: { type: string; text?: string } }).item)
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text ?? "")
    .join("\n");
}

describe.skipIf(!LIVE)("codex app-server (live)", () => {
  test("handshake, thread, goal overlay (no model calls)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const codex = yield* CodexAppServer;
        const started = yield* codex.request("thread/start", { cwd: workDir, approvalPolicy: "never", sandbox: "read-only" });
        const threadId = started.thread.id;
        // Paused, so Codex does not start continuing the goal on its own (that would call the model).
        const set = yield* codex.request("thread/goal/set", { threadId, objective: "Say OK", status: "paused", tokenBudget: 10_000 });
        const got = yield* codex.request("thread/goal/get", { threadId });
        const cleared = yield* codex.request("thread/goal/clear", { threadId });
        return { userAgent: codex.userAgent, threadId, set: set.goal, got: got.goal, cleared: cleared.cleared };
      }).pipe(Effect.provide(layerFor([]))),
    );
    expect(result.userAgent).toContain(CODEX_PROTOCOL_VERSION);
    expect(result.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.set).toMatchObject({ objective: "Say OK", status: "paused", tokenBudget: 10_000 });
    expect(result.got?.status).toBe("paused");
    expect(result.cleared).toBe(true);
  }, 60_000);

  // Depends on the device owner's ~/.codex being usable non-interactively (provider keys in env etc.).
  test.skipIf(process.env["OA_LIVE_NATIVE"] !== "1")("one turn with the device's own Codex configuration (native profile)", async () => {
    const notifications = await Effect.runPromise(
      Effect.gen(function* () {
        const codex = yield* CodexAppServer;
        const started = yield* codex.request("thread/start", { cwd: workDir, approvalPolicy: "never", sandbox: "read-only" });
        return yield* runTurn(started.thread.id, "Reply with exactly the word OK and nothing else. Do not run any tools.");
      }).pipe(Effect.provide(layerFor([]))),
    );
    record("native-ok-turn", notifications);
    expect(notifications.map((n) => n.method)).toContain("turn/started");
    const last = notifications.at(-1);
    expect(last?.method).toBe("turn/completed");
    const error = (last?.params as { turn?: { error?: { message?: string } | null } }).turn?.error;
    if (error) throw new Error(`native turn failed: ${error.message}`);
    expect(agentText(notifications)).toContain("OK");
  }, 200_000);

  test.skipIf(!proxyUrl || !proxyKey)("one turn through CLIProxyAPI via a platform profile (env_key auth)", async () => {
    const statuses = resolveProfiles([{ kind: "cliproxyapi", id: "live", baseUrl: proxyUrl!, apiKey: proxyKey! }]);
    const profile = statuses.find((s) => s.config.id === "live")?.resolved;
    if (!profile) throw new Error("profile not resolved");
    const model = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
    const notifications = await Effect.runPromise(
      Effect.gen(function* () {
        const codex = yield* CodexAppServer;
        const started = yield* codex.request("thread/start", {
          cwd: workDir,
          approvalPolicy: "never",
          sandbox: "read-only",
          model,
          ...codexThreadProvider(profile),
        });
        expect(started.modelProvider).toBe("openagents_live");
        return yield* runTurn(started.thread.id, "Reply with exactly the word OK and nothing else. Do not run any tools.");
      }).pipe(Effect.provide(layerFor([profile]))),
    );
    record("cliproxyapi-ok-turn", notifications);
    const failed = notifications.find((n) => n.method === "error");
    expect(failed).toBeUndefined();
    expect(agentText(notifications)).toContain("OK");
  }, 200_000);

  test.skipIf(!proxyUrl || !proxyKey)("isolated CODEX_HOME: no device MCP servers, hooks or plugins in platform threads", async () => {
    const home = mkdtempSync(join(tmpdir(), "oa-codex-home-"));
    const statuses = resolveProfiles([{ kind: "cliproxyapi", id: "live", baseUrl: proxyUrl!, apiKey: proxyKey! }]);
    const profile = statuses.find((s) => s.config.id === "live")!.resolved!;
    const model = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
    try {
      const notifications = await Effect.runPromise(
        Effect.gen(function* () {
          const codex = yield* CodexAppServer;
          const started = yield* codex.request("thread/start", {
            cwd: workDir,
            approvalPolicy: "never",
            sandbox: "read-only",
            model,
            ...codexThreadProvider(profile),
          });
          return yield* runTurn(started.thread.id, "Reply with exactly the word OK and nothing else. Do not run any tools.");
        }).pipe(Effect.provide(layerFor([profile], home))),
      );
      record("isolated-home-ok-turn", notifications);
      const methods = notifications.map((n) => n.method);
      expect(methods.filter((m) => m.startsWith("hook/") || m.startsWith("mcpServer/"))).toEqual([]);
      expect(agentText(notifications)).toContain("OK");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 200_000);

  test.skipIf(!proxyUrl || !proxyKey)("a turn with tools (file change + command), recorded for the event mapping", async () => {
    const home = mkdtempSync(join(tmpdir(), "oa-codex-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "oa-codex-tools-"));
    const statuses = resolveProfiles([{ kind: "cliproxyapi", id: "live", baseUrl: proxyUrl!, apiKey: proxyKey! }]);
    const profile = statuses.find((s) => s.config.id === "live")!.resolved!;
    const model = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
    try {
      const notifications = await Effect.runPromise(
        Effect.gen(function* () {
          const codex = yield* CodexAppServer;
          const started = yield* codex.request("thread/start", {
            cwd,
            approvalPolicy: "never",
            sandbox: "workspace-write",
            model,
            ...codexThreadProvider(profile),
          });
          return yield* runTurn(
            started.thread.id,
            "Create a file named hello.txt in the current directory containing exactly the text: hi\n" +
              "Then run the shell command `cat hello.txt`. Finally reply with the single word DONE.",
          );
        }).pipe(Effect.provide(layerFor([profile], home))),
      );
      record("tools-turn", notifications);
      const types = notifications
        .filter((n) => n.method === "item/completed")
        .map((n) => (n.params as { item: { type: string } }).item.type);
      expect(types).toContain("commandExecution");
      expect(await Bun.file(join(cwd, "hello.txt")).text()).toContain("hi");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);

  // Default after the 2026-11-01 decision: isolated CODEX_HOME with the device login linked in.
  test.skipIf(process.env["OA_LIVE_NATIVE"] !== "1")("native profile in the isolated home with the linked device login", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "oa-codex-data-"));
    try {
      const home = prepareCodexHome({ dataDir, linkDeviceLogin: true });
      expect(home.login).toBe("linked");
      const notifications = await Effect.runPromise(
        Effect.gen(function* () {
          const codex = yield* CodexAppServer;
          const started = yield* codex.request("thread/start", { cwd: workDir, approvalPolicy: "never", sandbox: "read-only" });
          return yield* runTurn(started.thread.id, "Reply with exactly the word OK and nothing else. Do not run any tools.");
        }).pipe(Effect.provide(layerFor([], home.path))),
      );
      record("native-isolated-ok-turn", notifications);
      const error = (notifications.at(-1)?.params as { turn?: { error?: { message?: string } | null } }).turn?.error;
      if (error) throw new Error(`native turn failed: ${error.message}`);
      expect(agentText(notifications)).toContain("OK");
      expect(notifications.map((n) => n.method).filter((m) => m.startsWith("hook/") || m.startsWith("mcpServer/"))).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 200_000);

  test("server requests seen during the tests", () => {
    // approvalPolicy "never" + read-only + a no-tool prompt: nothing should have asked.
    expect(serverRequests).toEqual([]);
  });
});

// dynamicTools exist only in thread/start (not thread/resume or thread/fork). The agent bus relies on
// Codex keeping them with the thread: after a restart of app-server (resume) and in forks.
describe.skipIf(!LIVE || !proxyUrl || !proxyKey)("codex dynamic tools (live)", () => {
  test("a tool given at thread/start is called in the thread, after resume in a new process, and in a fork", async () => {
    const home = mkdtempSync(join(tmpdir(), "oa-codex-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "oa-codex-dyn-"));
    const profile = resolveProfiles([{ kind: "cliproxyapi", id: "live", baseUrl: proxyUrl!, apiKey: proxyKey! }]).find((s) => s.config.id === "live")!
      .resolved!;
    const model = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
    const calls: { threadId: string; tool: string; arguments: unknown }[] = [];
    const layer = () =>
      CodexAppServer.layer({
        launch: codexAppServerLaunch([profile], process.env, "codex", undefined, home),
        clientVersion: "0.0.0-live",
        onServerRequest: async (request) => {
          if (request.method !== "item/tool/call") return {};
          const params = request.params as { threadId: string; tool: string; arguments: unknown };
          calls.push({ threadId: params.threadId, tool: params.tool, arguments: params.arguments });
          return { contentItems: [{ type: "inputText", text: "recorded" }], success: true };
        },
      });
    const settings = { cwd, approvalPolicy: "never", sandbox: "read-only", model, ...codexThreadProvider(profile) } as const;
    const ask = (token: string) => `Call the tool record_token with token "${token}". Then reply with the single word DONE.`;
    try {
      const threadId = await Effect.runPromise(
        Effect.gen(function* () {
          const codex = yield* CodexAppServer;
          const started = yield* codex.request("thread/start", {
            ...settings,
            dynamicTools: [
              {
                type: "function",
                name: "record_token",
                description: "Records a token for the test.",
                inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false },
              },
            ],
          });
          yield* runTurn(started.thread.id, ask("first"));
          return started.thread.id;
        }).pipe(Effect.provide(layer())),
      );
      // A new app-server process: the thread is resumed without dynamicTools, then forked.
      const forkId = await Effect.runPromise(
        Effect.gen(function* () {
          const codex = yield* CodexAppServer;
          yield* codex.request("thread/resume", { threadId, ...settings });
          yield* runTurn(threadId, ask("resumed"));
          const forked = yield* codex.request("thread/fork", { threadId, ...settings });
          yield* runTurn(forked.thread.id, ask("forked"));
          return forked.thread.id;
        }).pipe(Effect.provide(layer())),
      );
      const tokens = (id: string) => calls.filter((c) => c.threadId === id).map((c) => (c.arguments as { token?: string }).token);
      expect(calls.every((c) => c.tool === "record_token")).toBe(true);
      expect(tokens(threadId)).toEqual(["first", "resumed"]);
      expect(tokens(forkId)).toEqual(["forked"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 600_000);
});
