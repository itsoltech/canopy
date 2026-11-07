import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
  type ThreadSpec,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer } from "effect";
import { Journal } from "../../journal/index.ts";
import { startFakeModel } from "../../import/fixtures/fake-model.ts";
import { resolveProfiles, type ResolvedProfile } from "../profiles.ts";
import { codexAppServerLaunch } from "./launch.ts";
import { CodexThreads } from "./threads.ts";

const temp = tempDirs();
const codex = Bun.which("codex");

/** Real app-server, fake inference: no device homes, credentials or external model calls. */
test.skipIf(!codex)(
  "Codex keeps full history when resuming across device login and proxy connections",
  async () => {
    const root = temp("canopy-codex-connections-");
    const home = join(root, "codex");
    const cwd = join(root, "project");
    mkdirSync(home);
    mkdirSync(cwd);
    writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture" }));
    const first = startFakeModel();
    const second = startFakeModel();
    writeFileSync(join(home, "config.toml"), `openai_base_url = ${JSON.stringify(`${first.url}/v1`)}\n`);

    const env = {
      PATH: process.env["PATH"] ?? "",
      HOME: root,
      TMPDIR: process.env["TMPDIR"] ?? root,
    };

    const profile = (id: string, baseUrl?: string) =>
      resolveProfiles([
        baseUrl
          ? { id, kind: "cliproxyapi", baseUrl, apiKey: "fixture", providers: ["codex"] }
          : { id, kind: "native", providers: ["codex"] },
      ]).find((entry) => entry.config.id === id)!.resolved!;

    const spec = create(ThreadSpecSchema, {
      threadId: crypto.randomUUID(),
      provider: Provider.CODEX,
      providerProfileId: "native",
      cwd,
      model: "gpt-6.1-sol",
      permissionMode: PermissionMode.READ_ONLY,
    });

    const ask = async (connection: ResolvedProfile, previous: ThreadSpec, text: string) => {
      const events: ThreadEvent[] = [];
      const turnId = crypto.randomUUID();
      const current = { ...previous, providerProfileId: connection.id };

      const layer = CodexThreads.layer({
        launch: codexAppServerLaunch([connection], env, codex!, undefined, home),
        clientVersion: "test",
        profile: () => connection,
        publish: (event) => events.push(event),
        interact: async () => create(InteractionResponseSchema, { allow: false }),
        callTool: async () => create(AgentToolResultSchema, { isError: true }),
      }).pipe(Layer.provide(Journal.layer(join(root, "journal.db"))));

      return Effect.runPromise(
        Effect.gen(function* () {
          const threads = yield* CodexThreads;
          const providerThreadId = current.providerThreadId || (yield* threads.create(current));
          yield* threads.startTurn({ ...current, providerThreadId }, turnId, create(UserInputSchema, { text }));

          const finished = yield* Effect.gen(function* () {
            for (;;) {
              const done = events.find((event) => event.turnId === turnId && event.body.case === "turnFinished");

              if (done) return done;
              yield* Effect.sleep("20 millis");
            }
          }).pipe(Effect.timeout("15 seconds"));

          expect(
            finished.body.case === "turnFinished" && {
              outcome: finished.body.value.outcome,
              reason: finished.body.value.reason,
            },
          ).toEqual({ outcome: TurnOutcome.COMPLETED, reason: "" });

          return { ...current, providerThreadId };
        }).pipe(Effect.provide(layer)),
      );
    };

    try {
      const initial = await ask(profile("native"), spec, "Remember FIXTURE_CONNECTION_HISTORY");
      const proxy = await ask(profile("native", first.url), initial, "Cześć FIXTURE_PROXY");
      const changedProxy = await ask(profile("native", second.url), proxy, "Cześć FIXTURE_OTHER_PROXY");
      const changedProfile = await ask(profile("another", second.url), changedProxy, "Cześć FIXTURE_PROFILE");
      const native = await ask(profile("native"), changedProfile, "Cześć FIXTURE_BACK");
      expect(native.providerThreadId).toBe(initial.providerThreadId);
      expect(second.requests.at(-1)).toContain("FIXTURE_CONNECTION_HISTORY");
      expect(second.requests.at(-1)).toContain("FIXTURE_ANSWER FIXTURE_PROXY");
      expect(first.requests.at(-1)).toContain("FIXTURE_OTHER_PROXY");
      expect(first.requests.at(-1)).toContain("FIXTURE_PROFILE");
    } finally {
      await first.stop();
      await second.stop();
    }
  },
  60_000,
);
