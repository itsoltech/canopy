import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  Provider,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { ClaudeThreads } from "./threads.ts";
import { inputRecords } from "../../../../../tests/integration/fixtures/instance-probe.ts";

for (const cancel of [false, true]) {
  test(`Claude startup status keeps control admission open; cancelled=${cancel}`, async () => {
    const root = tempDir("canopy-claude-startup-");
    const home = join(root, "home");
    mkdirSync(home);
    const trace = join(root, "probe.jsonl");
    const executable = resolve(import.meta.dir, "../../../../../tests/integration/fixtures/claude-startup.ts");
    const events: ThreadEvent[] = [];
    const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["claude"] }])[0]!.resolved!;
    let allowed = true;
    let startup = false;

    const runtime = ManagedRuntime.make(
      ClaudeThreads.layer({
        home,
        executable,
        baseEnv: { PATH: process.env["PATH"], INSTANCE_TRACE: trace },
        nativeTools: { nativeSubagents: false, nativeScheduling: false },
        profile: () => profile,
        publish: (event) => {
          events.push(event);

          if (event.rawJson.includes('"subtype":"status"')) {
            startup = true;

            if (cancel) allowed = false;
          }
        },
        interact: async () => create(InteractionResponseSchema),
        callTool: async () => create(AgentToolResultSchema),
      }).pipe(Layer.provideMerge(Journal.layer(join(root, "journal.db")))),
    );

    const spec = create(ThreadSpecSchema, {
      threadId: crypto.randomUUID(),
      cwd: root,
      provider: Provider.CLAUDE,
      enableAgentBus: true,
    });

    const turnId = crypto.randomUUID();

    try {
      await runtime.runPromise(ClaudeThreads.use((threads) => threads.create(spec)));
      await runtime.runPromise(
        ClaudeThreads.use((threads) =>
          threads.startTurn(spec, turnId, create(UserInputSchema, { text: "KEEP" }), {
            model: "",
            effort: "",
            canSubmit: () => allowed,
          }),
        ).pipe(Effect.timeout("5 seconds")),
      );
      expect(startup).toBe(true);

      if (cancel) {
        expect(events.some((event) => event.turnId === turnId)).toBe(false);
        expect(inputRecords(trace)).toHaveLength(0);
      } else {
        await runtime.runPromise(
          Effect.gen(function* () {
            while (!events.some((event) => event.turnId === turnId && event.body.case === "turnFinished"))
              yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("5 seconds")),
        );
        expect(events.filter((event) => event.turnId === turnId && event.body.case === "turnStarted")).toHaveLength(1);
        const finished = events.filter((event) => event.turnId === turnId && event.body.case === "turnFinished");
        expect(finished).toHaveLength(1);
        expect(finished[0]?.body.case === "turnFinished" && finished[0].body.value.outcome).toBe(TurnOutcome.COMPLETED);
        expect(inputRecords(trace).flatMap((record) => record.parts.map((part) => part.text))).toEqual(["KEEP"]);
      }
    } finally {
      await runtime.dispose();
    }
  });
}
