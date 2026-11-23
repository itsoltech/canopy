import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  ForkSpecSchema,
  InteractionResponseSchema,
  ThreadSpecSchema,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDirs, waitForProcessStopped } from "@canopy/testing";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { CodexThreads } from "./threads.ts";

const temporary = tempDirs();

const Trace = Schema.Struct({
  method: Schema.String,
  threadId: Schema.String,
  lastTurnId: Schema.String,
  url: Schema.String,
  pid: Schema.Number,
  goalStatus: Schema.String,
});

const readTrace = (root: string) =>
  readFileSync(join(root, "trace.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeSync(Schema.fromJsonString(Trace))(line));

const releaseRuntime = (root: string, publish: (event: ThreadEvent) => void, failInterrupt = false) => {
  const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["codex"] }])[0]!.resolved!;

  return ManagedRuntime.make(
    CodexThreads.layer({
      launch: {
        command: [process.execPath, join(import.meta.dir, "fixtures/thread-release.ts")],
        env: { RELEASE_ROOT: root, RELEASE_FAIL_INTERRUPT: failInterrupt ? "1" : "" },
      },
      clientVersion: "test",
      profile: () => profile,
      publish,
      interact: async () => create(InteractionResponseSchema),
      callTool: async () => create(AgentToolResultSchema),
    }).pipe(Layer.provideMerge(Journal.layer(join(root, "journal.db")))),
  );
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }

  throw new Error("Fixture did not reach the expected state");
};

for (const phase of ["background", "admission", "active", "interrupt-failure"])
  test(`Codex unload releases one native session and MCP bridge during ${phase}`, async () => {
    const preparing = phase === "admission";
    const root = temporary("canopy-codex-release-");
    const events: ThreadEvent[] = [];
    const trace = () => readTrace(root);
    const runtime = releaseRuntime(root, (event) => events.push(event), phase === "interrupt-failure");

    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    try {
      const threads = await runtime.runPromise(CodexThreads);
      const a = create(ThreadSpecSchema, { threadId: crypto.randomUUID(), cwd: root, model: "fixture" });
      const b = create(ThreadSpecSchema, { threadId: crypto.randomUUID(), cwd: root, model: "fixture" });
      a.providerThreadId = await runtime.runPromise(threads.create(a));
      b.providerThreadId = await runtime.runPromise(threads.create(b));
      await runtime.runPromise(threads.startTurn(b, crypto.randomUUID(), create(UserInputSchema, { text: "HANG" })));
      const turnId = crypto.randomUUID();

      const starting = runtime.runPromise(
        threads.startTurn(
          a,
          turnId,
          create(UserInputSchema, { text: phase === "background" ? "BACKGROUND" : "HANG" }),
          {
            model: "fixture",
            effort: "",
            ...(preparing && {
              connectorsReady: () => {
                ready.resolve();

                return release.promise;
              },
            }),
          },
        ),
      );

      if (preparing) await ready.promise;
      else {
        await starting;

        if (phase === "background") {
          await until(() => events.some((e) => e.turnId === turnId && e.body.case === "turnFinished"));
          expect(threads.backgroundTasks().get(a.threadId)).toEqual(["process"]);
        }
      }

      const unloading = runtime.runPromise(threads.unload(a.threadId)).then(
        () => undefined,
        (error: Error) => error,
      );

      await Bun.sleep(10);
      release.resolve();
      await starting;
      const unloaded = await unloading;

      if (phase === "interrupt-failure") expect(unloaded?.message).toContain("fixture interrupt refused");
      else expect(unloaded).toBeUndefined();
      expect(threads.has(a.threadId)).toBe(false);
      expect(threads.has(b.threadId)).toBe(true);
      expect(threads.failure()).toBeUndefined();
      expect(threads.backgroundTasks().has(a.threadId)).toBe(false);
      expect(existsSync(join(root, "archived", `${a.providerThreadId}.jsonl`))).toBe(true);

      const methods = trace()
        .filter((entry) => entry.threadId === a.providerThreadId)
        .map((entry) => entry.method);

      expect(methods).toContain("thread/goal/set");
      expect(methods).toContain("thread/backgroundTerminals/clean");
      expect(methods).toContain("thread/archive");

      if (preparing) expect(methods).not.toContain("turn/start");

      if (phase === "active" || phase === "interrupt-failure") expect(methods).toContain("turn/interrupt");
      const bridges = trace().filter((entry) => entry.method === "thread/start");
      await expect(fetch(bridges[0]!.url)).rejects.toThrow();
      expect((await fetch(bridges[1]!.url)).status).toBe(401);
      await runtime.runPromise(threads.unload(a.threadId));
      await runtime.runPromise(threads.startTurn(a, crypto.randomUUID(), create(UserInputSchema, { text: "HANG" })));
      expect(threads.has(a.threadId)).toBe(true);
      expect(
        trace()
          .filter((entry) => entry.threadId === a.providerThreadId && entry.method === "turn/start")
          .at(-1)?.goalStatus,
      ).toBe("paused");
      expect(
        trace().filter((entry) => entry.threadId === a.providerThreadId && entry.method === "thread/goal/set"),
      ).toHaveLength(1);
      expect(existsSync(join(root, "sessions", `${a.providerThreadId}.jsonl`))).toBe(true);
      expect(
        trace()
          .filter((entry) => entry.method === "thread/resume")
          .at(-1)?.threadId,
      ).toBe(a.providerThreadId);
    } finally {
      release.resolve();
      await runtime.dispose();
    }
  });

test("Codex forks an archived rollout at the selected turn without resuming the source", async () => {
  const root = temporary("canopy-codex-fork-after-release-");
  const events: ThreadEvent[] = [];
  const runtime = releaseRuntime(root, (event) => events.push(event));
  const spec = () => create(ThreadSpecSchema, { threadId: crypto.randomUUID(), cwd: root, model: "fixture" });

  try {
    const threads = await runtime.runPromise(CodexThreads);
    const source = spec();
    source.providerThreadId = await runtime.runPromise(threads.create(source));
    const turnId = crypto.randomUUID();
    await runtime.runPromise(threads.startTurn(source, turnId, create(UserInputSchema, { text: "BACKGROUND" })));
    const finished = () => events.find((event) => event.turnId === turnId && event.body.case === "turnFinished")?.body;
    await until(() => finished()?.case === "turnFinished");
    const turn = finished();

    if (turn?.case !== "turnFinished") throw new Error("Missing completed source turn");

    const point = create(ForkSpecSchema, {
      sourceThreadId: source.threadId,
      sourceProviderThreadId: source.providerThreadId,
      afterTurnId: turnId,
      afterProviderTurnRef: turn.value.providerTurnRef,
    });

    await runtime.runPromise(threads.create(spec(), point));
    expect(readTrace(root).filter((entry) => entry.method === "thread/unarchive")).toHaveLength(0);

    await runtime.runPromise(threads.unload(source.threadId));
    expect(existsSync(join(root, "archived", `${source.providerThreadId}.jsonl`))).toBe(true);
    const before = readTrace(root).length;
    const fork = spec();
    const providerThreadId = await runtime.runPromise(threads.create(fork, point));

    expect(providerThreadId).not.toBe(source.providerThreadId);
    expect(threads.has(source.threadId)).toBe(false);
    expect(
      events.find((event) => event.threadId === fork.threadId && event.body.case === "threadReady")?.body,
    ).toMatchObject({
      case: "threadReady",
      value: { providerThreadId },
    });
    expect(
      readTrace(root)
        .slice(before)
        .filter((entry) => entry.threadId === source.providerThreadId)
        .map(({ method, lastTurnId }) => [method, lastTurnId]),
    ).toEqual([
      ["thread/fork", point.afterProviderTurnRef],
      ["thread/unarchive", ""],
      ["thread/fork", point.afterProviderTurnRef],
    ]);
  } finally {
    await runtime.dispose();
  }
});

test("Codex unload after app-server crash releases local bridges without native RPCs or restart", async () => {
  const root = temporary("canopy-codex-release-crash-");
  const runtime = releaseRuntime(root, () => {});

  try {
    const threads = await runtime.runPromise(CodexThreads);
    const a = create(ThreadSpecSchema, { threadId: crypto.randomUUID(), cwd: root, model: "fixture" });
    const b = create(ThreadSpecSchema, { threadId: crypto.randomUUID(), cwd: root, model: "fixture" });
    await runtime.runPromise(threads.create(a));
    await runtime.runPromise(threads.create(b));
    const records = readTrace(root);
    const bridges = records.filter((record) => record.method === "thread/start");
    process.kill(records[0]!.pid, "SIGKILL");
    await waitForProcessStopped(records[0]!.pid);
    await until(() => threads.failure() !== undefined);
    const before = readFileSync(join(root, "trace.jsonl"), "utf8");

    await runtime.runPromise(threads.unload(a.threadId).pipe(Effect.timeout("2 seconds")));
    expect(threads.has(a.threadId)).toBe(false);
    expect(threads.has(b.threadId)).toBe(true);
    await expect(fetch(bridges[0]!.url)).rejects.toThrow();
    expect((await fetch(bridges[1]!.url)).status).toBe(401);
    await runtime.runPromise(threads.unload(a.threadId));
    await runtime.runPromise(threads.unload(b.threadId));
    await expect(fetch(bridges[1]!.url)).rejects.toThrow();
    expect(threads.has(b.threadId)).toBe(false);
    expect(readFileSync(join(root, "trace.jsonl"), "utf8")).toBe(before);
  } finally {
    await runtime.dispose();
  }
});
