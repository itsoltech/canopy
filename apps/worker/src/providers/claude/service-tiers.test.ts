import { expect, test } from "bun:test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  ThreadSpecSchema,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { ClaudeThreads } from "./threads.ts";

const temporary = tempDirs();

const records = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(line)));

function fixture(reason: string) {
  const root = temporary("canopy-claude-tiers-");
  const home = join(root, "home");
  mkdirSync(home);
  const trace = join(root, "trace.jsonl");
  const events: ThreadEvent[] = [];
  const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["claude"] }])[0]!.resolved!;

  const runtime = ManagedRuntime.make(
    ClaudeThreads.layer({
      home,
      executable: join(import.meta.dir, "../fixtures/service-tiers.ts"),
      baseEnv: { PATH: process.env["PATH"], TIER_TRACE: trace, ...(reason && { TIER_DISABLED: reason }) },
      nativeTools: { nativeSubagents: false, nativeScheduling: false },
      profile: () => profile,
      publish: (event) => events.push(event),
      interact: async () => create(InteractionResponseSchema),
      callTool: async () => create(AgentToolResultSchema),
    }).pipe(Layer.provideMerge(Journal.layer(join(root, "journal.db")))),
  );

  return { root, trace, runtime, events };
}

function finished(events: ThreadEvent[], turnId: string) {
  return Effect.gen(function* () {
    while (!events.some((event) => event.turnId === turnId && event.body.case === "turnFinished"))
      yield* Effect.sleep("5 millis");
  }).pipe(Effect.timeout("5 seconds"));
}

for (const reason of ["", "free", "extra_usage_disabled", "pending", "not_first_party"])
  test(`Claude discovers model and account availability without inference; reason=${reason || "available"}`, async () => {
    const { trace, runtime } = fixture(reason);

    try {
      const threads = await runtime.runPromise(ClaudeThreads);
      const catalog = await runtime.runPromise(threads.listModels("native"));
      expect(catalog.models[0]?.serviceTiers?.map((tier) => tier.id)).toEqual(reason ? undefined : ["fast"]);
      expect(catalog.models[1]?.serviceTiers).toBeUndefined();
      expect(records(trace).some((row) => row["method"] === "prompt")).toBe(false);
    } finally {
      await runtime.dispose();
    }
  }, 15_000);

test("Claude resets live and resumed fast sessions, and preserves the thread default", async () => {
  const { root, trace, runtime, events } = fixture("");

  try {
    const threads = await runtime.runPromise(ClaudeThreads);
    const spec = create(ThreadSpecSchema, { threadId: crypto.randomUUID(), cwd: root, serviceTier: "fast" });
    spec.providerThreadId = await runtime.runPromise(threads.create(spec));

    for (const serviceTier of ["", "default", "", "default"]) {
      const turnId = crypto.randomUUID();
      await runtime.runPromise(
        threads.startTurn(spec, turnId, create(UserInputSchema, { text: "Continue" }), {
          model: "",
          effort: "",
          serviceTier,
        }),
      );
      await runtime.runPromise(finished(events, turnId));

      const usage = events.flatMap((event) =>
        event.turnId === turnId && event.body.case === "usageUpdated" && event.body.value.usage?.scope
          ? [event.body.value.usage]
          : [],
      );

      expect(usage.length).toBeGreaterThan(0);
      expect(new Set(usage.map((snapshot) => snapshot.requestedServiceTier))).toEqual(new Set([serviceTier || "fast"]));

      if (serviceTier === "default") await runtime.runPromise(threads.unload(spec.threadId));
    }

    const prompts = records(trace).filter((row) => row["method"] === "prompt");
    expect(prompts.map((row) => row["fast"])).toEqual([true, false, true, false]);
    const spawns = records(trace).filter((row) => row["method"] === "spawn");
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.["resume"]).toBe(spec.providerThreadId);
    // Clearing the thread preference must reset a transcript whose last request selected fast.
    const cold = create(ThreadSpecSchema, { ...spec, serviceTier: "" });
    const next = crypto.randomUUID();
    await runtime.runPromise(threads.startTurn(cold, next, create(UserInputSchema, { text: "Standard" })));
    await runtime.runPromise(finished(events, next));
    expect(
      records(trace)
        .filter((row) => row["method"] === "prompt")
        .at(-1)?.["fast"],
    ).toBe(false);
  } finally {
    await runtime.dispose();
  }
}, 15_000);

for (const model of ["", "small"])
  test(`Claude refuses unavailable fast mode before sending user input; model=${model || "default"}`, async () => {
    const { root, trace, runtime } = fixture(model ? "" : "extra_usage_disabled");

    try {
      const threads = await runtime.runPromise(ClaudeThreads);
      const spec = create(ThreadSpecSchema, { threadId: crypto.randomUUID(), cwd: root });
      await runtime.runPromise(threads.create(spec));

      const error = await runtime.runPromise(
        threads
          .startTurn(spec, crypto.randomUUID(), create(UserInputSchema, { text: "Must not run" }), {
            model,
            effort: "",
            serviceTier: "fast",
          })
          .pipe(Effect.flip),
      );

      expect(error.message).toContain("unavailable");
      expect(records(trace).some((row) => row["method"] === "prompt")).toBe(false);
    } finally {
      await runtime.dispose();
    }
  }, 15_000);
