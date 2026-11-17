import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  ForkSpecSchema,
  ThreadSpecSchema,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { CodexThreads } from "./threads.ts";

const temporary = tempDirs();

const records = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(line)));

for (const disabled of [false, true])
  test(`Codex forwards account tiers and resets every native lifecycle request; disabled=${disabled}`, async () => {
    const root = temporary("canopy-codex-tiers-");
    const trace = join(root, "trace.jsonl");
    const events: ThreadEvent[] = [];
    const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["codex"] }])[0]!.resolved!;

    const runtime = ManagedRuntime.make(
      CodexThreads.layer({
        launch: {
          command: [process.execPath, join(import.meta.dir, "../fixtures/service-tiers.ts"), "--codex"],
          env: { PATH: process.env["PATH"], TIER_TRACE: trace, ...(disabled && { TIER_DISABLED: "1" }) },
        },
        clientVersion: "test",
        profile: () => profile,
        publish: (event) => events.push(event),
        interact: async () => create(InteractionResponseSchema),
        callTool: async () => create(AgentToolResultSchema),
      }).pipe(Layer.provideMerge(Journal.layer(join(root, "journal.db")))),
    );

    try {
      const threads = await runtime.runPromise(CodexThreads);
      const catalog = await runtime.runPromise(threads.listModels("native"));
      expect(catalog.models[0]?.serviceTiers?.map((tier) => tier.id)).toEqual(
        disabled ? undefined : ["fast", "ultrafast"],
      );

      const spec = create(ThreadSpecSchema, {
        threadId: crypto.randomUUID(),
        cwd: root,
        model: "fixture",
        serviceTier: disabled ? "" : "fast",
      });

      await runtime.runPromise(threads.create(spec));
      const turnId = crypto.randomUUID();
      await runtime.runPromise(
        threads.startTurn(spec, turnId, create(UserInputSchema, { text: "First" }), {
          model: "",
          effort: "",
          serviceTier: disabled ? "default" : "ultrafast",
        }),
      );

      if (!disabled) {
        const rejected = await runtime.runPromise(
          threads
            .steer(spec.threadId, turnId, crypto.randomUUID(), create(UserInputSchema, { text: "Different speed" }), {
              serviceTier: "default",
            })
            .pipe(Effect.flip),
        );

        expect(rejected.code).toBe("STEER_REJECTED");
        await runtime.runPromise(
          threads.steer(spec.threadId, turnId, crypto.randomUUID(), create(UserInputSchema, { text: "Same speed" }), {
            serviceTier: "ultrafast",
          }),
        );
      }

      await runtime.runPromise(
        threads.startTurn(spec, crypto.randomUUID(), create(UserInputSchema, { text: "Reset override" }), {
          model: "",
          effort: "",
          serviceTier: "default",
        }),
      );
      await runtime.runPromise(
        threads.startTurn(spec, crypto.randomUUID(), create(UserInputSchema, { text: "Inherit thread" }), {
          model: "",
          effort: "",
          serviceTier: "",
        }),
      );

      const reset = create(ThreadSpecSchema, {
        threadId: crypto.randomUUID(),
        providerThreadId: "saved-session",
        cwd: root,
        model: "fixture",
      });

      await runtime.runPromise(
        threads.startTurn(reset, crypto.randomUUID(), create(UserInputSchema, { text: "Resume standard" })),
      );
      await runtime.runPromise(
        threads.startTurn(reset, crypto.randomUUID(), create(UserInputSchema, { text: "Explicit standard" }), {
          model: "",
          effort: "",
          serviceTier: "default",
        }),
      );
      await runtime.runPromise(
        threads.create(
          create(ThreadSpecSchema, { ...reset, threadId: crypto.randomUUID() }),
          create(ForkSpecSchema, {
            sourceThreadId: spec.threadId,
            sourceProviderThreadId: "source",
            afterTurnId: "",
            afterProviderTurnRef: "",
          }),
        ),
      );
      const wire = records(trace);

      const usage = () =>
        events.flatMap((event) =>
          event.body.case === "usageUpdated" && event.body.value.usage?.scope ? [event.body.value.usage] : [],
        );

      await runtime.runPromise(
        Effect.gen(function* () {
          while (usage().length < 5) yield* Effect.sleep("5 millis");
        }).pipe(Effect.timeout("5 seconds")),
      );
      expect(usage().map((snapshot) => snapshot.requestedServiceTier)).toEqual([
        disabled ? "default" : "ultrafast",
        "default",
        disabled ? "default" : "fast",
        "default",
        "default",
      ]);
      expect(usage().map((snapshot) => snapshot.reportedCostUsd)).toEqual([42, 42, 42, 42, 42]);

      const native = wire.filter((row) =>
        ["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(String(row["method"])),
      );

      expect(native.map((row) => row["params"])).toMatchObject([
        { serviceTier: disabled ? "default" : "fast" },
        { serviceTier: disabled ? "default" : "ultrafast" },
        { serviceTier: "default" },
        { serviceTier: disabled ? "default" : "fast" },
        { serviceTier: "default" },
        { serviceTier: "default" },
        { serviceTier: "default" },
        { serviceTier: "default" },
      ]);

      const unavailable = await runtime.runPromise(
        threads
          .startTurn(reset, crypto.randomUUID(), create(UserInputSchema, { text: "Unavailable" }), {
            model: "",
            effort: "",
            serviceTier: disabled ? "fast" : "invented",
          })
          .pipe(Effect.flip),
      );

      expect(unavailable.message).toContain("unavailable");
      expect(wire.filter((row) => row["method"] === "turn/steer")).toHaveLength(disabled ? 0 : 1);
    } finally {
      await runtime.dispose();
    }
  }, 15_000);
