import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
function fixture() {
  const root = temp("canopy-codex-connections-");
  const home = join(root, "codex");
  const device = join(root, "cli");
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const first = startFakeModel();
  const second = startFakeModel();

  for (const [dir, model] of [
    [home, first],
    [device, second],
  ] as const) {
    mkdirSync(dir);
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture" }));
    writeFileSync(join(dir, "config.toml"), `openai_base_url = ${JSON.stringify(`${model.url}/v1`)}\n`);
  }

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

  const ask = async (
    connection: ResolvedProfile,
    previous: ThreadSpec,
    text: string,
    options: { direct?: boolean; unload?: boolean; imported?: boolean } = {},
  ) => {
    const events: ThreadEvent[] = [];
    const turnId = crypto.randomUUID();
    const current = { ...previous, providerProfileId: connection.id };

    const layer = CodexThreads.layer({
      launch: codexAppServerLaunch(
        [connection],
        env,
        codex!,
        undefined,
        options.direct ? { cliHome: device, privateHome: home } : home,
        {},
        options.direct ? ["-c", `sqlite_home=${JSON.stringify(home)}`] : [],
      ),
      ...(options.direct && { previousPrivateHome: home }),
      ...(options.imported && {
        importedResumePath: () => {
          throw new Error("Use the private imported copy.");
        },
      }),
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

        expect(
          events.some((event) => event.body.case === "threadReady" && event.body.value.replacesProviderThreadId),
        ).toBe(false);

        if (options.unload) yield* threads.unload(current.threadId);

        return { ...current, providerThreadId };
      }).pipe(Effect.provide(layer)),
    );
  };

  return { profile, spec, ask, first, second, device };
}

test.skipIf(!codex)(
  "Codex keeps full history when resuming across device login and proxy connections",
  async () => {
    const { profile, spec, ask, first, second } = fixture();

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

test.skipIf(!codex)(
  "direct CLI login resumes archived private history, unloads it and keeps it usable with a private connection",
  async () => {
    const { profile, spec, ask, first, second, device } = fixture();
    const native = profile("native");

    try {
      const original = await ask(native, spec, "FIXTURE_PRIVATE", { unload: true });
      await ask(native, original, "FIXTURE_DIRECT", { direct: true, unload: true });
      expect(second.requests.at(-1)).toContain("FIXTURE_ANSWER FIXTURE_PRIVATE");
      await ask(native, original, "FIXTURE_BACK");
      expect(first.requests.at(-1)).toContain("FIXTURE_ANSWER FIXTURE_DIRECT");

      const created = await ask(native, { ...spec, threadId: crypto.randomUUID() }, "FIXTURE_CLI", {
        direct: true,
        unload: true,
      });

      const archived = join(device, "archived_sessions");
      const names = readdirSync(archived);
      expect(names.some((name) => name.includes(created.providerThreadId))).toBe(true);
      await expect(ask(native, created, "FIXTURE_IMPORT", { direct: true, imported: true })).rejects.toThrow(
        "Use the private imported copy.",
      );
      expect(readdirSync(archived)).toEqual(names);
      await expect(ask(native, created, "FIXTURE_BLOCK")).rejects.toThrow("Select the CLI home");
      await ask(native, created, "FIXTURE_CLI_AGAIN", { direct: true });
      expect(second.requests.at(-1)).toContain("FIXTURE_ANSWER FIXTURE_CLI");
    } finally {
      await first.stop();
      await second.stop();
    }
  },
  60_000,
);
