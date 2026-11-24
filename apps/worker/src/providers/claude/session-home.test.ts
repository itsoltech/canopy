import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentToolResultSchema,
  ForkSpecSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  RewindThreadSchema,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { ClaudeThreads } from "./threads.ts";
import { transcriptPath } from "./transcript.ts";
import { claudeSessionHomes } from "./session-home.ts";

const temp = tempDirs();
const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["claude"] }])[0]!.resolved!;
const cwd = "/repo/project";

const spec = () =>
  create(ThreadSpecSchema, {
    threadId: crypto.randomUUID(),
    provider: Provider.CLAUDE,
    permissionMode: PermissionMode.READ_ONLY,
    cwd,
  });

function withRuntime<A, E>(
  root: string,
  home: string,
  program: Effect.Effect<A, E, ClaudeThreads | Journal>,
  platformHome = home,
) {
  return Effect.runPromise(
    program.pipe(
      Effect.provide(
        ClaudeThreads.layer({
          home,
          baseEnv: {},
          nativeTools: { nativeSubagents: false, nativeScheduling: false },
          profile: () => profile,
          runtimeOf: () => ({ home, platformHome }),
          publish: () => {},
          interact: async () => create(InteractionResponseSchema),
          callTool: async () => create(AgentToolResultSchema),
        }).pipe(Layer.provideMerge(Journal.layer(join(root, "journal.db")))),
      ),
    ),
  );
}

/** A real native transcript shape consumed by SDK forkSession, without invoking a model. */
function seed(home: string, sessionId: string) {
  const project = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const user = crypto.randomUUID();
  const answer = crypto.randomUUID();

  const entries = [
    {
      type: "user",
      uuid: user,
      parentUuid: null,
      message: { role: "user", content: "durable source memory" },
    },
    {
      type: "assistant",
      uuid: answer,
      parentUuid: user,
      message: {
        id: "msg_durable",
        role: "assistant",
        model: "claude-x",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "remembered answer" }],
      },
    },
  ];

  const path = join(project, `${sessionId}.jsonl`);
  writeFileSync(
    path,
    entries.map((entry) => JSON.stringify({ ...entry, sessionId, cwd, isSidechain: false }) + "\n").join(""),
  );

  return { path, ref: answer };
}

test("first creation prepares the home before binding and a restart never recreates a missing bound home", async () => {
  const root = temp("canopy-claude-first-home-");
  const home = join(root, "not-created-yet");
  const thread = spec();
  await withRuntime(
    root,
    home,
    Effect.gen(function* () {
      const threads = yield* ClaudeThreads;
      const journal = yield* Journal;
      expect(yield* journal.isClaudeSessionHomeBound(home)).toBe(false);
      yield* threads.create(thread);
      expect(statSync(home).isDirectory()).toBe(true);
      expect(yield* journal.isClaudeSessionHomeBound(home)).toBe(true);
    }),
  );
  rmSync(home, { recursive: true });
  await expect(
    withRuntime(
      root,
      home,
      ClaudeThreads.use((threads) => threads.create(thread)),
    ),
  ).rejects.toThrow("session home is unavailable");
  expect(existsSync(home)).toBe(false);
});

test("fork and rewind retain the source home after policy changes and journal reopening", async () => {
  const root = temp("canopy-claude-binding-");
  const original = join(root, "original");
  const changed = join(root, "changed");
  mkdirSync(original);
  mkdirSync(changed);
  const source = spec();
  await withRuntime(
    root,
    original,
    ClaudeThreads.use((t) => t.create(source)),
  );
  source.providerThreadId = source.threadId;
  const transcript = seed(original, source.threadId);
  const before = readFileSync(transcript.path, "utf8");
  const child = spec();
  source.cwd = child.cwd = join(root, "new-worktree");
  mkdirSync(source.cwd);
  await withRuntime(
    root,
    changed,
    Effect.gen(function* () {
      const threads = yield* ClaudeThreads;
      const journal = yield* Journal;
      child.providerThreadId = yield* threads.create(
        child,
        create(ForkSpecSchema, {
          sourceThreadId: source.threadId,
          sourceProviderThreadId: source.providerThreadId,
          afterProviderTurnRef: transcript.ref,
        }),
      );
      expect(yield* journal.claudeSessionHome(child.threadId)).toBe(original);
      expect(readFileSync(transcriptPath(original, child.providerThreadId)!, "utf8")).toContain(
        "durable source memory",
      );
      expect(transcriptPath(changed, child.providerThreadId)).toBeUndefined();

      const fresh = spec();
      yield* threads.create(fresh);
      expect(yield* journal.claudeSessionHome(fresh.threadId)).toBe(changed);
    }),
  );
  await withRuntime(
    root,
    changed,
    Effect.gen(function* () {
      const threads = yield* ClaudeThreads;

      const result = yield* threads.rewind(
        create(RewindThreadSchema, {
          thread: source,
          sourceProviderThreadId: source.providerThreadId,
          afterProviderTurnRef: transcript.ref,
        }),
      );

      expect(readFileSync(transcriptPath(original, result.providerThreadId ?? "")!, "utf8")).toContain(
        "remembered answer",
      );
      expect(transcriptPath(changed, result.providerThreadId ?? "")).toBeUndefined();
      const journal = yield* Journal;
      expect(yield* journal.claudeSessionHome(child.threadId)).toBe(original);
    }),
  );
  expect(readFileSync(transcript.path, "utf8")).toBe(before);
});

test("an unbound legacy source can be forked from its private home without binding the source", async () => {
  const root = temp("canopy-claude-legacy-home-");
  const original = join(root, "private");
  const shared = join(root, "shared");
  mkdirSync(original);
  mkdirSync(shared);
  const source = spec();
  source.providerThreadId = source.threadId;
  const transcript = seed(original, source.providerThreadId);
  await withRuntime(
    root,
    shared,
    Effect.gen(function* () {
      const threads = yield* ClaudeThreads;
      const journal = yield* Journal;
      const child = spec();

      const sessionId = yield* threads.create(
        child,
        create(ForkSpecSchema, {
          sourceThreadId: source.threadId,
          sourceProviderThreadId: source.providerThreadId,
          afterProviderTurnRef: transcript.ref,
        }),
      );

      expect(yield* journal.claudeSessionHome(source.threadId)).toBeUndefined();
      expect(yield* journal.claudeSessionHome(child.threadId)).toBe(original);
      expect(readFileSync(transcriptPath(original, sessionId)!, "utf8")).toContain("durable source memory");
      yield* threads.rewind(
        create(RewindThreadSchema, {
          thread: source,
          sourceProviderThreadId: source.providerThreadId,
          afterProviderTurnRef: transcript.ref,
        }),
      );
      expect(yield* journal.claudeSessionHome(source.threadId)).toBe(original);
    }),
    original,
  );
});

test("missing bound home and deleted history fail before a turn can start with blank history", async () => {
  const root = temp("canopy-claude-missing-home-");
  const original = join(root, "original");
  const changed = join(root, "changed");
  mkdirSync(original);
  mkdirSync(changed);
  const thread = spec();
  await withRuntime(
    root,
    original,
    Effect.gen(function* () {
      const threads = yield* ClaudeThreads;
      const journal = yield* Journal;
      yield* threads.create(thread);
      const transcript = seed(original, thread.threadId);
      yield* journal.append(thread.threadId, { turnId: "first", body: { case: "turnStarted", value: {} } });
      yield* journal.noteHarness(thread.threadId, "first", {
        harness: "claude",
        transcript: original,
        sessionId: thread.threadId,
        offset: 0,
        providerTurn: "",
      });

      const end = yield* journal.append(thread.threadId, {
        turnId: "first",
        body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } },
      });

      yield* journal.ack(thread.threadId, end.journalSeq);
      rmSync(transcript.path);
    }),
  );

  const start = () =>
    withRuntime(
      root,
      changed,
      ClaudeThreads.use((threads) =>
        threads.startTurn(thread, crypto.randomUUID(), create(UserInputSchema, { text: "recall history" })),
      ),
    );

  await expect(start()).rejects.toThrow("session history is unavailable");
  rmSync(original, { recursive: true });
  await expect(start()).rejects.toThrow("session home is unavailable");
  expect(transcriptPath(changed, thread.threadId)).toBeUndefined();
});

test("a legacy used session without a transcript fails, while explicit empty rewind survives restart", async () => {
  const root = temp("canopy-claude-empty-rewind-");
  const home = join(root, "home");
  mkdirSync(home);
  const thread = spec();
  await withRuntime(
    root,
    home,
    Effect.gen(function* () {
      const journal = yield* Journal;
      // A completed turn from before home bindings existed, with its outbox already ACKed.
      yield* journal.append(thread.threadId, { turnId: "legacy", body: { case: "turnStarted", value: {} } });

      const end = yield* journal.append(thread.threadId, {
        turnId: "legacy",
        body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } },
      });

      yield* journal.ack(thread.threadId, end.journalSeq);
    }),
  );
  await expect(
    withRuntime(
      root,
      home,
      ClaudeThreads.use((threads) =>
        threads.startTurn(thread, crypto.randomUUID(), create(UserInputSchema, { text: "recall" })),
      ),
    ),
  ).rejects.toThrow("session history is unavailable");

  const empty = await withRuntime(
    root,
    home,
    ClaudeThreads.use((threads) => threads.rewind(create(RewindThreadSchema, { thread, empty: true }))),
  );

  thread.providerThreadId = empty.providerThreadId ?? "";
  const previous = process.env["CLAUDE_CONFIG_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = home;

  try {
    await withRuntime(
      root,
      home,
      Journal.use((journal) =>
        Effect.promise(async () => {
          const resume = await claudeSessionHomes(journal).resume(
            thread,
            home,
            async (sessionId) => (await getSessionMessages(sessionId)).length > 0,
          );

          expect(resume).toBe(false);
          expect(await Effect.runPromise(journal.hasStartedClaudeThread(thread.threadId))).toBe(true);
        }),
      ),
    );
  } finally {
    if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = previous;
  }
});
