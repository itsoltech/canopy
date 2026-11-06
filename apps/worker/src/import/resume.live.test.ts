/**
 * Live: an imported session resumes with the real agent CLI and the real model (docs/import.md, "Testy").
 * Opt-in: CANOPY_LIVE=1 with CANOPY_LIVE_CLIPROXYAPI_URL/KEY. A session made outside Canopy learns a code word; it is
 * scanned, copied into Canopy's private home and resumed there; the agent must still know the word.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AdoptImportedSessionSchema,
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer } from "effect";
import { mkdirSync } from "node:fs";
import { Journal } from "../journal/index.ts";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { DEFAULT_NATIVE_TOOL_POLICY } from "../providers/native-tools.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { adoptImportedSession } from "./adopt.ts";
import { treeFingerprint } from "./fixtures/install.ts";
import { WorkerImport } from "./service.ts";

const LIVE = process.env["CANOPY_LIVE"] === "1";
const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];
const temp = tempDirs();

function liveProfile(cli: "claude" | "codex" | "grok") {
  return resolveProfiles([
    { kind: "cliproxyapi", id: "live", baseUrl: proxyUrl ?? "", apiKey: proxyKey ?? "", providers: [cli] },
  ]).find((p) => p.config.id === "live")!.resolved!;
}

function agentText(events: readonly ThreadEvent[]): string {
  return events
    .flatMap((e) =>
      e.body.case === "itemCompleted" && e.body.value.item?.content.case === "agentMessage"
        ? [e.body.value.item.content.value.text]
        : [],
    )
    .join("\n");
}

/** One Claude turn with the real CLI in `home` (a config dir), until it ends. */
async function claudeTurn(home: string, cwd: string, sessionId: string, text: string, dataDir: string) {
  const events: ThreadEvent[] = [];
  const ended = Promise.withResolvers<void>();
  const profile = liveProfile("claude");
  const env = { PATH: process.env["PATH"] ?? "", HOME: join(dataDir, "os-home"), TMPDIR: dataDir };
  mkdirSync(env.HOME, { recursive: true });

  const spec = create(ThreadSpecSchema, {
    threadId: crypto.randomUUID(),
    provider: Provider.CLAUDE,
    providerProfileId: "live",
    providerThreadId: sessionId,
    cwd,
    model: process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5",
    permissionMode: PermissionMode.READ_ONLY,
  });

  const program = Effect.gen(function* () {
    const threads = yield* ClaudeThreads;
    yield* threads.create(spec);
    yield* threads.startTurn(spec, crypto.randomUUID(), create(UserInputSchema, { text }));
    yield* Effect.promise(() => Promise.race([ended.promise, Bun.sleep(120_000)]));
  }).pipe(
    Effect.provide(
      ClaudeThreads.layer({
        profile: () => profile,
        publish: (event: ThreadEvent) => {
          events.push(event);

          if (event.body.case === "turnFinished") ended.resolve();
        },
        interact: async () => create(InteractionResponseSchema, { allow: false }),
        callTool: async () => create(AgentToolResultSchema, { isError: true }),
        home,
        baseEnv: env,
        executable: Bun.which("claude")!,
        nativeTools: DEFAULT_NATIVE_TOOL_POLICY,
      }).pipe(Layer.provide(Journal.layer(join(dataDir, `journal-${crypto.randomUUID()}.db`)))),
    ),
  );

  await Effect.runPromise(program);

  return events;
}

/** One Codex turn with the real app-server in `home` (a CODEX_HOME); a new thread when `threadId` is empty. */
async function codexTurn(home: string, cwd: string, threadId: string, text: string, dataDir: string) {
  const events: ThreadEvent[] = [];
  const ended = Promise.withResolvers<void>();
  let started = threadId;
  const profile = liveProfile("codex");
  const env = { PATH: process.env["PATH"] ?? "", HOME: join(dataDir, "os-home"), TMPDIR: dataDir };
  mkdirSync(env.HOME, { recursive: true });

  const spec = create(ThreadSpecSchema, {
    threadId: crypto.randomUUID(),
    provider: Provider.CODEX,
    providerProfileId: "live",
    providerThreadId: threadId,
    cwd,
    model: process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol",
    permissionMode: PermissionMode.READ_ONLY,
  });

  const program = Effect.gen(function* () {
    const threads = yield* CodexThreads;

    if (!started) started = yield* threads.create(spec);
    yield* threads.startTurn(
      create(ThreadSpecSchema, { ...spec, providerThreadId: started }),
      crypto.randomUUID(),
      create(UserInputSchema, { text }),
    );
    yield* Effect.promise(() => Promise.race([ended.promise, Bun.sleep(180_000)]));
  }).pipe(
    Effect.provide(
      CodexThreads.layer({
        profile: () => profile,
        publish: (event: ThreadEvent) => {
          events.push(event);

          if (event.body.case === "turnFinished") ended.resolve();
        },
        interact: async () => create(InteractionResponseSchema, { allow: false }),
        callTool: async () => create(AgentToolResultSchema, { isError: true }),
        launch: codexAppServerLaunch([profile], env, Bun.which("codex")!, undefined, home),
        clientVersion: "live",
      }).pipe(Layer.provide(Journal.layer(join(dataDir, `journal-${crypto.randomUUID()}.db`)))),
    ),
  );

  await Effect.runPromise(program);

  return { events, threadId: started };
}

describe.skipIf(!LIVE || !proxyUrl || !proxyKey)("live: imported sessions resume", () => {
  test.skipIf(!Bun.which("codex"))(
    "Codex: a rollout from the user's CODEX_HOME continues in Canopy and remembers its history",
    async () => {
      const root = temp("canopy-import-live-codex-");
      const userHome = join(root, "user");
      const cwd = join(root, "project");
      mkdirSync(join(userHome, ".codex"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      const word = `otter-${crypto.randomUUID().slice(0, 6)}`;

      const first = await codexTurn(
        join(userHome, ".codex"),
        cwd,
        "",
        `Remember the code word ${word}. Reply only: OK.`,
        join(root, "a"),
      );

      const service = new WorkerImport({
        dataDir: join(root, "worker"),
        homes: () => ({
          claude: join(userHome, ".claude"),
          codex: join(userHome, ".codex"),
          grok: join(userHome, ".grok"),
        }),
        config: () => undefined,
      });

      const summary = (await service.scan(["codex"])).threads.find((t) => t.nativeId === first.threadId)!;
      const before = treeFingerprint(join(userHome, ".codex", "sessions"));
      const privateHome = join(root, "worker", "codex-home");

      const adopted = adoptImportedSession(
        service,
        { claudeHome: () => privateHome, codexHome: () => privateHome },
        create(AdoptImportedSessionSchema, { sourceKey: summary.sourceKey, snapshot: summary.snapshot }),
      );

      const second = await codexTurn(
        privateHome,
        cwd,
        adopted,
        "What was the code word? Reply with the word only.",
        join(root, "b"),
      );

      expect(agentText(second.events).toLowerCase()).toContain(word);
      expect(treeFingerprint(join(userHome, ".codex", "sessions"))).toBe(before);
    },
    400_000,
  );

  test.skipIf(!Bun.which("claude"))(
    "Claude Code: a session from the user's CLI home continues in Canopy and remembers its history",
    async () => {
      const root = temp("canopy-import-live-claude-");
      const userHome = join(root, "user");
      const cwd = join(root, "project");
      mkdirSync(join(userHome, ".claude"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      const word = `koala-${crypto.randomUUID().slice(0, 6)}`;
      const sessionId = crypto.randomUUID();
      // The user's own session, outside Canopy.
      await claudeTurn(
        join(userHome, ".claude"),
        cwd,
        sessionId,
        `Remember the code word ${word}. Reply only: OK.`,
        join(root, "a"),
      );

      const service = new WorkerImport({
        dataDir: join(root, "worker"),
        homes: () => ({
          claude: join(userHome, ".claude"),
          codex: join(userHome, ".codex"),
          grok: join(userHome, ".grok"),
        }),
        config: () => undefined,
      });

      const summary = (await service.scan(["claude"])).threads.find((t) => t.nativeId === sessionId)!;
      const before = treeFingerprint(join(userHome, ".claude"));
      const privateHome = join(root, "worker", "claude-home");

      const adopted = adoptImportedSession(
        service,
        { claudeHome: () => privateHome, codexHome: () => privateHome },
        create(AdoptImportedSessionSchema, { sourceKey: summary.sourceKey, snapshot: summary.snapshot }),
      );

      const events = await claudeTurn(
        privateHome,
        cwd,
        adopted,
        "What was the code word? Reply with the word only.",
        join(root, "b"),
      );

      expect(agentText(events).toLowerCase()).toContain(word);
      expect(treeFingerprint(join(userHome, ".claude"))).toBe(before);
    },
    300_000,
  );
});
