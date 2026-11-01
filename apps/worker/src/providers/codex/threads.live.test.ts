/**
 * Live: platform threads on Codex end to end. Opt-in (OA_LIVE=1, CLIProxyAPI env, see codex-adapter.md).
 * Create -> turn -> fork (inherits history) -> worker restart (new app-server, same CODEX_HOME and
 * journal) -> resume -> turn. Events go through the mapper into the journal.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  ForkSpecSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
  type ThreadEvent,
  type ThreadSpec,
} from "@open-agents/contracts";
import { Effect, Layer } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { prepareCodexHome } from "./home.ts";
import { codexAppServerLaunch } from "./launch.ts";
import { CodexThreads } from "./threads.ts";

const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];
const model = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";

describe.skipIf(!LIVE || !proxyUrl || !proxyKey)("Codex threads (live)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "oa-codex-threads-"));
  const cwd = mkdtempSync(join(tmpdir(), "oa-codex-threads-cwd-"));
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const profile = resolveProfiles([{ kind: "cliproxyapi", id: "live", baseUrl: proxyUrl ?? "", apiKey: proxyKey ?? "" }]).find(
    (s) => s.config.id === "live",
  )?.resolved;
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
});
