import { expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  Provider,
  RewindThreadSchema,
  ThreadSpecSchema,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { CodexThreads } from "./threads.ts";

test("Codex prefix replacement excludes superseded turns after a runtime restart and restores the original session", async () => {
  const root = tempDir("canopy-codex-rewind-");
  const events: ThreadEvent[] = [];
  const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["codex"] }])[0]!.resolved!;

  const runtime = () =>
    ManagedRuntime.make(
      CodexThreads.layer({
        launch: {
          command: [process.execPath, join(import.meta.dir, "fixtures/rewind.ts")],
          env: { PATH: process.env["PATH"], CODEX_HOME: root },
        },
        clientVersion: "test",
        profile: () => profile,
        publish: (event) => events.push(event),
        interact: async () => create(InteractionResponseSchema),
        callTool: async () => create(AgentToolResultSchema),
      }).pipe(Layer.provideMerge(Journal.layer(join(root, "journal.db")))),
    );

  let worker = runtime();
  const spec = create(ThreadSpecSchema, { threadId: Bun.randomUUIDv7(), cwd: root, provider: Provider.CODEX });

  const send = async (text: string) => {
    const id = Bun.randomUUIDv7();
    await worker.runPromise(
      CodexThreads.use((threads) => threads.startTurn(spec, id, create(UserInputSchema, { text }))),
    );
    await worker.runPromise(
      Effect.gen(function* () {
        while (!events.some((event) => event.turnId === id && event.body.case === "turnFinished"))
          yield* Effect.sleep("5 millis");
      }).pipe(Effect.timeout("5 seconds")),
    );

    return events.find((event) => event.turnId === id && event.body.case === "turnFinished");
  };

  try {
    spec.providerThreadId = await worker.runPromise(CodexThreads.use((threads) => threads.create(spec)));
    const original = spec.providerThreadId;
    const first = await send("APPLE");
    await send("BANANA");
    await send("CHERRY");

    const result = await worker.runPromise(
      CodexThreads.use((threads) =>
        threads.rewind(
          create(RewindThreadSchema, {
            thread: spec,
            sourceProviderThreadId: original,
            afterProviderTurnRef: first?.body.case === "turnFinished" ? first.body.value.providerTurnRef : "",
          }),
        ),
      ),
    );

    spec.providerThreadId = result.providerThreadId!;
    await worker.dispose();
    worker = runtime();
    await send("BLUEBERRY");

    const messages = events.flatMap((event) =>
      event.body.case === "itemCompleted" && event.body.value.item?.content.case === "agentMessage"
        ? [event.body.value.item.content.value.text]
        : [],
    );

    expect(messages.at(-1)).toBe("APPLE | BLUEBERRY");
    await worker.runPromise(
      CodexThreads.use((threads) =>
        threads.rewind(
          create(RewindThreadSchema, {
            thread: spec,
            restoreProviderThreadId: original,
          }),
        ),
      ),
    );
    spec.providerThreadId = original;
    await send("RESTORED");

    const restored = events.flatMap((event) =>
      event.body.case === "itemCompleted" && event.body.value.item?.content.case === "agentMessage"
        ? [event.body.value.item.content.value.text]
        : [],
    );

    expect(restored.at(-1)).toBe("APPLE | BANANA | CHERRY | RESTORED");
  } finally {
    await worker.dispose();
  }
});
