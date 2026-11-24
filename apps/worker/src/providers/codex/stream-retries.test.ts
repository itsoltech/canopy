import { expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer } from "effect";
import { codexToolModel } from "../../bots/fixtures/codex-model.ts";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { codexAppServerLaunch } from "./launch.ts";
import { CodexThreads } from "./threads.ts";

const temp = tempDirs();
const codex = Bun.which("codex");

test.skipIf(!codex)(
  "a proxy stream exhausts ten attempts in one Codex turn without adding user input",
  async () => {
    const dir = temp("canopy-stream-retries-");

    const dropped = () =>
      new Response('data: {"type":"response.created","response":{"id":"cut"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });

    // The first and last requests lose their stream. Server-directed delays keep the intervening retries short.
    const busy = Array.from({ length: 8 }, () => new Response(null, { status: 503, headers: { "retry-after": "0" } }));
    const model = codexToolModel([dropped(), ...busy, dropped()]);

    const profile = resolveProfiles([
      { id: "fixture", kind: "cliproxyapi", baseUrl: model.url, apiKey: "fixture", providers: ["codex"] },
    ]).find((entry) => entry.config.id === "fixture")!.resolved!;

    const events: ThreadEvent[] = [];
    const finished = Promise.withResolvers<ThreadEvent>();
    const turnId = crypto.randomUUID();

    const layer = CodexThreads.layer({
      launch: codexAppServerLaunch([profile], { PATH: process.env["PATH"], HOME: dir }, codex!, undefined, dir),
      clientVersion: "test",
      profile: () => profile,
      publish: (event) => {
        events.push(event);

        if (event.turnId === turnId && event.body.case === "turnFinished") finished.resolve(event);
      },
      interact: async () => create(InteractionResponseSchema, { allow: false }),
      callTool: async () => create(AgentToolResultSchema, { isError: true }),
    }).pipe(Layer.provide(Journal.layer(join(dir, "journal.db"))));

    try {
      const end = await Effect.runPromise(
        Effect.gen(function* () {
          const threads = yield* CodexThreads;

          const spec = create(ThreadSpecSchema, {
            threadId: crypto.randomUUID(),
            provider: Provider.CODEX,
            cwd: dir,
            model: "gpt-6.1-sol",
            permissionMode: PermissionMode.READ_ONLY,
            enableAgentBus: true,
            projectSecretsConfigured: true,
          });

          spec.providerThreadId = yield* threads.create(spec);
          yield* threads.startTurn(spec, turnId, create(UserInputSchema, { text: "Check the fixture" }));

          return yield* Effect.promise(() => finished.promise);
        }).pipe(Effect.provide(layer), Effect.timeout("20 seconds")),
      );

      expect(end.body.value).toMatchObject({ outcome: TurnOutcome.FAILED, reason: expect.stringContaining("stream") });
      expect(model.requests).toHaveLength(10);
      expect(new Set(model.requests).size).toBe(1);
      expect(events.filter((event) => event.body.case === "turnStarted")).toHaveLength(1);
      const retries = events.filter((event) => event.rawJson.includes('"willRetry":true'));
      expect(retries).toHaveLength(9);
      expect(retries.every((event) => !event.body.case)).toBe(true);
    } finally {
      await model.stop();
    }
  },
  25_000,
);
