/**
 * Live: platform threads on Codex end to end. Opt-in (OA_LIVE=1, CLIProxyAPI env, see codex-adapter.md).
 * Create -> turn -> fork (inherits history) -> worker restart (new app-server, same CODEX_HOME and
 * journal) -> resume -> turn. Events go through the mapper into the journal.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  ForkSpecSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
  type Item,
  type ThreadEvent,
  type ThreadSpec,
} from "@open-agents/contracts";
import { eventItemId, reduceItem } from "@open-agents/domain";
import { tempDirs } from "@open-agents/testing";
import { Effect, Layer } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { prepareCodexHome } from "./home.ts";
import { codexAppServerLaunch } from "./launch.ts";
import { CodexThreads } from "./threads.ts";

const tempDir = tempDirs();

const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];
const model = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
const recordDir = process.env["OA_LIVE_RECORD_DIR"] ?? "/tmp/oa-codex-recordings";

describe.skipIf(!LIVE || !proxyUrl || !proxyKey)("Codex threads (live)", () => {
  const dataDir = tempDir("oa-codex-threads-");
  const cwd = tempDir("oa-codex-threads-cwd-");

  // bun runs the body of a skipped describe too: resolve only when the live env is present.
  const profile =
    proxyUrl && proxyKey
      ? resolveProfiles([{ kind: "cliproxyapi", id: "live", baseUrl: proxyUrl, apiKey: proxyKey }]).find((s) => s.config.id === "live")?.resolved
      : undefined;
  const published: ThreadEvent[] = [];

  /** One "worker process": app-server + journal; disposed at the end like a shutdown. */
  const worker = () => {
    const home = prepareCodexHome({ dataDir, linkDeviceLogin: false });
    return CodexThreads.layer({
      launch: codexAppServerLaunch(profile ? [profile] : [], process.env, "codex", undefined, home.path),
      clientVersion: "0.0.0-live",
      profile: (id) => (id === "live" ? profile : undefined),
      publish: (event) => published.push(event),
      interact: async (request) => create(InteractionResponseSchema, { requestId: request.requestId, allow: false }),
      callTool: async (call) => create(AgentToolResultSchema, { callId: call.callId, isError: true, content: "not used in this test" }),
    }).pipe(Layer.provideMerge(Journal.layer(join(dataDir, "journal.db"))));
  };

  const spec = (threadId: string, providerThreadId = ""): ThreadSpec =>
    create(ThreadSpecSchema, {
      threadId,
      provider: Provider.CODEX,
      providerProfileId: "live",
      cwd,
      model,
      permissionMode: PermissionMode.READ_ONLY,
      providerThreadId,
    });

  const finished = (turnId: string) =>
    Effect.gen(function* () {
      for (;;) {
        const done = published.find((e) => e.turnId === turnId && e.body.case === "turnFinished");
        if (done) return done;
        yield* Effect.sleep("100 millis");
      }
    }).pipe(Effect.timeout("180 seconds"));

  const answer = (turnId: string) =>
    published
      .filter((e) => e.turnId === turnId && e.body.case === "itemCompleted")
      .map((e) => (e.body.case === "itemCompleted" ? e.body.value.item?.content : undefined))
      .filter((c) => c?.case === "agentMessage" && c.value.phase === "final_answer")
      .map((c) => (c?.case === "agentMessage" ? c.value.text : ""))
      .join("\n");

  const ask = (threads: CodexThreads["Service"], s: ThreadSpec, turnId: string, text: string) =>
    Effect.gen(function* () {
      yield* threads.startTurn(s, turnId, create(UserInputSchema, { text }));
      const done = yield* finished(turnId);
      expect(done.body.case === "turnFinished" && done.body.value.outcome).toBe(TurnOutcome.COMPLETED);
      return { answer: answer(turnId), providerTurnRef: done.body.case === "turnFinished" ? done.body.value.providerTurnRef : "" };
    });

  test("create, turn, fork with inherited history, restart and resume", async () => {
    const mainId = Bun.randomUUIDv7();
    const forkId = Bun.randomUUIDv7();

    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const threads = yield* CodexThreads;
        const codexMain = yield* threads.create(spec(mainId));
        const t1 = yield* ask(threads, spec(mainId), "turn-1", "Remember the codeword PAPAYA. Reply with just OK.");
        const fork = create(ForkSpecSchema, { sourceThreadId: mainId, sourceProviderThreadId: codexMain, afterTurnId: "turn-1", afterProviderTurnRef: t1.providerTurnRef });
        const codexFork = yield* threads.create(spec(forkId), fork);
        const t2 = yield* ask(threads, spec(forkId), "turn-2", "What was the codeword? Reply with just the word.");
        return { codexMain, codexFork, t1, t2 };
      }).pipe(Effect.provide(worker())),
    );
    expect(first.t1.answer).toContain("OK");
    expect(first.codexFork).not.toBe(first.codexMain);
    expect(first.t2.answer.toUpperCase()).toContain("PAPAYA"); // the fork inherited the history

    // "Worker restart": a new app-server process with the same CODEX_HOME and journal; the thread is resumed.
    const resumed = await Effect.runPromise(
      Effect.gen(function* () {
        const threads = yield* CodexThreads;
        return yield* ask(threads, spec(mainId, first.codexMain), "turn-3", "What was the codeword? Reply with just the word.");
      }).pipe(Effect.provide(worker())),
    );
    expect(resumed.answer.toUpperCase()).toContain("PAPAYA");

    // Everything went through the journal: thread_ready for both threads, increasing journal_seq per thread.
    const ready = published.filter((e) => e.body.case === "threadReady").map((e) => e.threadId);
    expect(ready).toEqual([mainId, forkId]);
    for (const threadId of [mainId, forkId]) {
      const seqs = published.filter((e) => e.threadId === threadId).map((e) => Number(e.journalSeq));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    }
    // Turn ids are the platform's, bound through clientUserMessageId / pending turns.
    expect(published.filter((e) => e.body.case === "turnStarted").map((e) => e.turnId)).toEqual(["turn-1", "turn-2", "turn-3"]);
  }, 600_000);

  // The reported gap: in code mode a command failing like a sandbox denial (ping without network) had no item.
  test("every command is in the transcript, also one that fails at once, before and after a restart", async () => {
    const threadId = Bun.randomUUIDv7();
    const repo = tempDir("oa-codex-commands-");
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "a\n");
    const s = (providerThreadId = "") => create(ThreadSpecSchema, { ...spec(threadId, providerThreadId), cwd: repo, permissionMode: PermissionMode.FULL_AUTO });
    const prompt = "Run these shell commands: `ping -c 4 8.8.8.8`, `ls -lah` and `git status`. Then summarize the results briefly.";
    try {
      const codexThread = await Effect.runPromise(
        Effect.gen(function* () {
          const threads = yield* CodexThreads;
          const id = yield* threads.create(s());
          yield* ask(threads, s(), "cmd-1", prompt);
          return id;
        }).pipe(Effect.provide(worker())),
      );
      // A new process resumes the thread: only the rollout still has what app-server does not notify about.
      await Effect.runPromise(
        Effect.gen(function* () {
          const threads = yield* CodexThreads;
          yield* ask(threads, s(codexThread), "cmd-2", prompt);
        }).pipe(Effect.provide(worker())),
      );
      const events = published.filter((e) => e.threadId === threadId);
      // What the mapper read, for the fixture (consecutive events of one notification share raw_json).
      const raw = events.map((e) => e.rawJson).filter((json, i, all) => json && json !== all[i - 1]);
      mkdirSync(recordDir, { recursive: true });
      writeFileSync(join(recordDir, "commands-turn.jsonl"), raw.join("\n") + "\n");

      for (const turnId of ["cmd-1", "cmd-2"]) {
        const items = new Map<string, Item>();
        for (const e of events.filter((e) => e.turnId === turnId)) {
          const id = eventItemId(e.body);
          const next = id ? reduceItem(items.get(id), e.body) : undefined;
          if (id && next) items.set(id, next);
        }
        // Each command is a command item, or part of a code-mode cell with its result (exit code included).
        const shown = [...items.values()].map((item) =>
          item.content.case === "commandExecution"
            ? `${item.content.value.command} => exit ${item.content.value.exitCode} ${item.content.value.output}`
            : item.content.case === "toolCall"
              ? `${item.content.value.inputJson} => ${item.content.value.output}`
              : "",
        );
        for (const command of ["ping -c 4 8.8.8.8", "ls -lah", "git status"]) {
          expect(shown.some((text) => text.includes(command))).toBe(true);
        }
        expect(shown.some((text) => text.includes("ping") && /exit_code\\?"?:\s*2|exit 2/.test(text) && text.includes("Operation not permitted"))).toBe(true);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 600_000);

  // Codex writes a rollout with the first turn: a thread (or fork) without turns cannot be resumed by a new process.
  test("threads without a turn survive a restart: a new Codex thread, a fork keeps its history", async () => {
    const emptyId = Bun.randomUUIDv7();
    const sourceId = Bun.randomUUIDv7();
    const forkId = Bun.randomUUIDv7();
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const threads = yield* CodexThreads;
        const empty = yield* threads.create(spec(emptyId));
        const source = yield* threads.create(spec(sourceId));
        const t1 = yield* ask(threads, spec(sourceId), "nr-1", "Remember the codeword MANGO. Reply with just OK.");
        const fork = create(ForkSpecSchema, { sourceThreadId: sourceId, sourceProviderThreadId: source, afterTurnId: "nr-1", afterProviderTurnRef: t1.providerTurnRef });
        return { empty, fork: yield* threads.create(spec(forkId), fork) };
      }).pipe(Effect.provide(worker())),
    );
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const threads = yield* CodexThreads;
        const empty = yield* ask(threads, spec(emptyId, first.empty), "nr-2", "Reply with just OK.");
        const fork = yield* ask(threads, spec(forkId, first.fork), "nr-3", "What was the codeword? Reply with just the word.");
        return { empty, fork };
      }).pipe(Effect.provide(worker())),
    );
    expect(second.empty.answer).toContain("OK");
    expect(second.fork.answer.toUpperCase()).toContain("MANGO");
    // The empty thread got a new Codex thread, announced as replacing the old one.
    const replaced = published.filter((e) => e.threadId === emptyId && e.body.case === "threadReady").map((e) => e.body.case === "threadReady" && e.body.value);
    expect(replaced).toHaveLength(2);
    const fresh = replaced[1] && replaced[1].providerThreadId;
    expect(replaced[1]).toMatchObject({ replacesProviderThreadId: first.empty });
    expect(fresh).not.toBe(first.empty);
    // A third process resumes the new thread (it has a rollout now).
    const third = await Effect.runPromise(
      Effect.gen(function* () {
        const threads = yield* CodexThreads;
        return yield* ask(threads, spec(emptyId, fresh || ""), "nr-4", "Reply with just OK.");
      }).pipe(Effect.provide(worker())),
    );
    expect(third.answer).toContain("OK");
    expect(published.filter((e) => e.threadId === emptyId && e.body.case === "threadReady")).toHaveLength(2);
  }, 600_000);
});
