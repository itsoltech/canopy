import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  CreateThreadSchema,
  InteractionResponseSchema,
  Provider,
  RewindThreadSchema,
  StartTurnSchema,
  ThreadSpecSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { Journal } from "../journal/index.ts";
import { HeadTracker } from "../git/heads.ts";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { HostState } from "./host-state.ts";
import { HostContext } from "./host-context.ts";
import { inputRecords } from "../../../../tests/integration/fixtures/instance-probe.ts";

const until = (ready: () => boolean) =>
  Effect.runPromise(
    Effect.gen(function* () {
      while (!ready()) yield* Effect.sleep("5 millis");
    }).pipe(Effect.timeout("10 seconds")),
  );

for (const provider of [Provider.CLAUDE, Provider.CODEX]) {
  test(`${Provider[provider]} rewind drains admission before turn_started and fences queued and replayed starts`, async () => {
    const root = tempDir("canopy-rewind-admission-");
    const home = join(root, "home");
    mkdirSync(home);
    const runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));
    const state = new HostState({ runtime, dataDir: root, clientVersion: "test" });
    state.heads = new HeadTracker(() => {});
    const ctx = new HostContext(state, { applyConfig: async () => ({}), sendPreviews: () => {} });
    const events: ThreadEvent[] = [];
    const publish = ctx.ops.publish;
    ctx.ops.publish = (event) => {
      events.push(event);
      publish(event);
    };

    const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["claude", "codex"] }])[0]!.resolved!;
    const scope = await Effect.runPromise(Scope.make());
    const trace = join(root, "probe.jsonl");

    const common = {
      profile: () => profile,
      publish: (event: ThreadEvent) => ctx.ops.publish(event),
      interact: async () => create(InteractionResponseSchema),
      callTool: async () => create(AgentToolResultSchema),
    };

    const claude = await runtime.runPromise(
      Layer.buildWithScope(
        ClaudeThreads.layer({
          ...common,
          home,
          executable: resolve(import.meta.dir, "../../../../tests/integration/fixtures/instance-claude.ts"),
          baseEnv: { PATH: process.env["PATH"], INSTANCE_TRACE: trace },
          nativeTools: { nativeSubagents: false, nativeScheduling: false },
        }),
        scope,
      ),
    );

    const codex = await runtime.runPromise(
      Layer.buildWithScope(
        CodexThreads.layer({
          ...common,
          clientVersion: "test",
          launch: {
            command: [process.execPath, resolve(import.meta.dir, "../providers/codex/fixtures/rewind.ts")],
            env: { PATH: process.env["PATH"], CODEX_HOME: home },
          },
        }),
        scope,
      ),
    );

    state.claude.set("native", { key: "test", scope, context: claude });
    state.codex.set("native", { key: "test", scope, context: codex });
    let pause: (() => Promise<void>) | undefined;

    const acquired = async () => {
      const wait = pause;
      pause = undefined;
      await wait?.();
    };

    ctx.ops.runClaude = async (use) => {
      await acquired();

      return runtime.runPromise(Effect.provide(ClaudeThreads.use(use), claude));
    };

    ctx.ops.runCodex = async (_provider, use) => {
      await acquired();

      return runtime.runPromise(Effect.provide(CodexThreads.use(use), codex));
    };

    // Fixture runtimes are fixed for this test; production reconciliation is tested separately.
    ctx.ops.reconcileRuntimes = async () => {};

    const spec = create(ThreadSpecSchema, { threadId: Bun.randomUUIDv7(), cwd: root, provider, enableAgentBus: true });

    const start = (text: string) =>
      create(StartTurnSchema, { thread: spec, turnId: Bun.randomUUIDv7(), input: { text } });

    const send = async (text: string) => {
      const value = start(text);
      await ctx.ops.startTurn({ case: "startTurn", value }, Bun.randomUUIDv7());
      await until(() => events.some((event) => event.turnId === value.turnId && event.body.case === "turnFinished"));
    };

    let release = () => {};

    try {
      await ctx.ops.createThread({ case: "createThread", value: create(CreateThreadSchema, { thread: spec }) });
      const ready = events.find((event) => event.body.case === "threadReady");
      spec.providerThreadId = ready?.body.case === "threadReady" ? ready.body.value.providerThreadId : "";
      const original = spec.providerThreadId;
      await send("APPLE");
      await send("BANANA");
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      release = held.resolve;
      pause = () => {
        entered.resolve();

        return held.promise;
      };

      const pending = start("CHERRY");
      const queued = start("DATE");
      const admitting = ctx.ops.startTurn({ case: "startTurn", value: pending }, Bun.randomUUIDv7());
      await entered.promise;
      const waiting = ctx.ops.startTurn({ case: "startTurn", value: queued }, Bun.randomUUIDv7());
      let completed = false;

      const rewinding = ctx.ops
        .rewindThread(
          create(RewindThreadSchema, {
            thread: spec,
            empty: true,
            cancelledTurnIds: [pending.turnId, queued.turnId],
          }),
        )
        .then((result) => {
          completed = true;

          return result;
        });

      await until(() => runtime.runSync(Journal.use((j) => j.wasInterrupted(spec.threadId, pending.turnId))));
      expect(completed).toBe(false);
      expect(events.some((event) => event.turnId === pending.turnId && event.body.case === "turnStarted")).toBe(false);
      release();
      await Promise.all([admitting, waiting]);
      const result = await rewinding;
      spec.providerThreadId = result.rewind?.providerThreadId ?? "";
      expect(spec.providerThreadId).not.toBe(original);
      await ctx.ops.startTurn({ case: "startTurn", value: pending }, Bun.randomUUIDv7());
      await send("BLUEBERRY");
      const cancelled = new Set([pending.turnId, queued.turnId]);
      expect(events.filter((event) => cancelled.has(event.turnId))).toEqual([]);

      if (provider === Provider.CLAUDE) {
        expect(inputRecords(trace).map((record) => record.parts.map((part) => part.text ?? "").join(""))).toEqual([
          "APPLE",
          "BANANA",
          "BLUEBERRY",
        ]);
        const folder = root.replace(/[^a-zA-Z0-9]/g, "-");
        expect(readFileSync(join(home, "projects", folder, `${original}.jsonl`), "utf8")).not.toContain("BLUEBERRY");
      } else {
        const messages = events.flatMap((event) =>
          event.body.case === "itemCompleted" && event.body.value.item?.content.case === "agentMessage"
            ? [event.body.value.item.content.value.text]
            : [],
        );

        expect(messages.at(-1)).toBe("BLUEBERRY");
        expect(readFileSync(join(home, `${original}.json`), "utf8")).not.toContain("BLUEBERRY");
      }
    } finally {
      release();
      state.heads.close();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  }, 30_000);
}
