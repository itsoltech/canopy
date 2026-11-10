import { expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  TurnOrigin,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { PROCESS_LIMITS, processGovernor } from "@canopy/process-governor";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { CodexThreads, type CodexThreadsOptions } from "./threads.ts";

const temp = tempDirs();

function fixture(events: ThreadEvent[], logs: string[], enrich?: CodexThreadsOptions["enrich"]) {
  const root = temp("canopy-codex-turn-boundaries-");
  const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["codex"] }])[0]!.resolved!;

  return CodexThreads.layer({
    launch: {
      command: [process.execPath, join(import.meta.dir, "fixtures/turn-boundaries.ts")],
      env: { PATH: process.env["PATH"] },
    },
    clientVersion: "test",
    profile: () => profile,
    publish: (event) => events.push(event),
    log: (message) => logs.push(message),
    ...(enrich && { enrich }),
    interact: async () => create(InteractionResponseSchema, { allow: false }),
    callTool: async () => create(AgentToolResultSchema, { isError: true }),
  }).pipe(Layer.provide(Journal.layer(join(root, "journal.db"))));
}

const spec = () =>
  create(ThreadSpecSchema, {
    threadId: Bun.randomUUIDv7(),
    cwd: "/repo",
    provider: Provider.CODEX,
    providerProfileId: "native",
    permissionMode: PermissionMode.ASK,
  });

function finished(events: ThreadEvent[], turnId: string) {
  return Effect.gen(function* () {
    while (!events.some((e) => e.turnId === turnId && e.body.case === "turnFinished")) yield* Effect.sleep("5 millis");
  }).pipe(Effect.timeout("5 seconds"));
}

test("Codex binds a prompt to its RPC response across native wake-ups and late events", async () => {
  const events: ThreadEvent[] = [];
  const logs: string[] = [];
  let active = () => false;
  const activeWhileJournaling: boolean[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const threads = yield* CodexThreads;
      active = () => threads.hasActiveTurns();
      const thread = spec();
      yield* threads.create(thread);
      const first = Bun.randomUUIDv7();
      yield* threads.startTurn(thread, first, create(UserInputSchema, { text: "rebuild the landing page" }));
      yield* finished(events, first);
      expect(threads.backgroundTasks().get(thread.threadId)).toEqual(["background-process"]);

      const next = Bun.randomUUIDv7();
      const text = "WAKE: publish the new page for the team";
      const providerTurn = yield* threads.startTurn(thread, next, create(UserInputSchema, { text }));
      yield* finished(events, next);
      const starts = events.filter((e) => e.body.case === "turnStarted");
      const requested = starts.find((e) => e.turnId === next);
      expect(requested?.body.case === "turnStarted" && requested.body.value).toMatchObject({
        providerTurnRef: providerTurn,
        origin: TurnOrigin.COMMAND,
      });
      const wake = starts.find((e) => e.body.case === "turnStarted" && e.body.value.providerTurnRef === "wake-2");
      expect(wake?.turnId).not.toBe(next);
      expect(wake?.body.case === "turnStarted" && wake.body.value.origin).toBe(TurnOrigin.PROVIDER);
      expect(
        events.flatMap((e) =>
          e.turnId === next && e.body.case === "itemCompleted" ? [e.body.value.item?.content] : [],
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ case: "userMessage", value: expect.objectContaining({ clientId: next, text }) }),
          expect.objectContaining({ case: "agentMessage", value: expect.objectContaining({ text: `Echo: ${text}` }) }),
        ]),
      );
      expect(events.filter((e) => e.turnId === next && e.body.case === "turnFinished")).toHaveLength(1);
      expect(
        events.some(
          (e) =>
            e.turnId === first &&
            e.body.case === "itemCompleted" &&
            e.body.value.item?.content.case === "agentMessage" &&
            e.body.value.item.content.value.text.startsWith("Late summary"),
        ),
      ).toBe(true);
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toMatchObject({
        event: "codex_late_turn_event",
        threadId: thread.threadId,
        turnId: first,
        providerTurnId: "requested-1",
      });
      expect(logs.join("\n")).not.toContain(text);
      expect(activeWhileJournaling.length).toBeGreaterThan(0);
      expect(activeWhileJournaling.every(Boolean)).toBe(true);
    }).pipe(
      Effect.provide(
        fixture(events, logs, async (init) => {
          if (init.body?.case === "turnFinished") activeWhileJournaling.push(active());

          return init;
        }),
      ),
      Effect.scoped,
    ),
  );
});

test("Codex releases buffered native events after a failed start and accepts input with all harness slots occupied", async () => {
  const events: ThreadEvent[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const threads = yield* CodexThreads;
      const thread = spec();
      yield* threads.create(thread);
      const rejected = Bun.randomUUIDv7();

      const failure = yield* threads
        .startTurn(thread, rejected, create(UserInputSchema, { text: "FAIL_START" }))
        .pipe(Effect.flip);

      expect(failure.operation).toBe("turn/start");
      expect(events.some((e) => e.turnId === rejected)).toBe(false);
      const wake = events.find((e) => e.body.case === "turnStarted");
      expect(wake?.body.case === "turnStarted" && wake.body.value.origin).toBe(TurnOrigin.PROVIDER);
      expect(events.some((e) => e.turnId === wake?.turnId && e.body.case === "turnFinished")).toBe(true);

      const release: (() => void)[] = [];

      try {
        const active = processGovernor.snapshot().byKind["harness"] ?? 0;

        for (let i = active; i < PROCESS_LIMITS.harness; i++) release.push(processGovernor.reserve("harness"));
        const turnId = Bun.randomUUIDv7();
        yield* threads.startTurn(thread, turnId, create(UserInputSchema, { text: "new request while saturated" }));
        yield* finished(events, turnId);
        expect(
          events.some(
            (e) =>
              e.turnId === turnId &&
              e.body.case === "itemCompleted" &&
              e.body.value.item?.content.case === "agentMessage" &&
              e.body.value.item.content.value.text === "Echo: new request while saturated",
          ),
        ).toBe(true);
      } finally {
        for (const done of release) done();
      }
    }).pipe(Effect.provide(fixture(events, [])), Effect.scoped),
  );
});
