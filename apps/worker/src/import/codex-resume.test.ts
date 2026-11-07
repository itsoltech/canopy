import { expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AdoptImportedSessionSchema,
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
import { Journal } from "../journal/index.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { adoptImportedSession } from "./adopt.ts";
import { prepareImportedCodexResume } from "./codex-provider.ts";
import { removeCopy } from "./copy.ts";
import { startFakeModel } from "./fixtures/fake-model.ts";
import { installFixtureHome, treeFingerprint } from "./fixtures/install.ts";
import { WorkerImport } from "./service.ts";

const temp = tempDirs();
const codex = Bun.which("codex");
const versionHome = codex ? temp("canopy-import-codex-version-") : "";

const validatesSavedProvider =
  codex &&
  /codex-cli 0\.166\./.test(
    Bun.spawnSync([codex, "--version"], {
      env: { PATH: process.env["PATH"] ?? "", HOME: versionHome, USERPROFILE: versionHome, CODEX_HOME: versionHome },
    }).stdout.toString(),
  );

/** Real Codex, fake inference: foreign provider, old copies, cold resume and full history without paid calls. */
test.skipIf(!codex).each(["native", "proxy"])(
  "the real Codex continues a foreign-provider import on Canopy's %s connection",
  async (connection) => {
    const root = temp("canopy-import-codex-resume-");
    const home = join(root, "home");
    const dataDir = join(root, "data");
    installFixtureHome(home, ["codex"]);
    const sourceHome = join(home, ".codex");

    for (const rel of readdirSync(sourceHome, { recursive: true })
      .map(String)
      .filter((p) => p.endsWith(".jsonl"))) {
      const file = join(sourceHome, rel);
      writeFileSync(
        file,
        readFileSync(file, "utf8")
          .replaceAll('"model_provider":"fixture"', '"model_provider":"cliproxyapi"')
          .replaceAll('"model_provider_id":"fixture"', '"model_provider_id":"cliproxyapi"'),
      );
    }

    writeFileSync(join(sourceHome, "auth.json"), JSON.stringify({ token: "about FIXTURE_THINK" }));

    const service = new WorkerImport({
      dataDir,
      homes: () => ({ claude: join(home, ".claude"), codex: sourceHome, grok: join(home, ".grok") }),
      config: () => undefined,
    });

    const before = treeFingerprint(sourceHome);
    const summary = (await service.scan(["codex"])).threads.find((t) => t.cwd === join(home, "project"))!;
    const privateHome = join(dataDir, "codex-home");
    const homes = { claudeHome: () => privateHome, codexHome: () => privateHome, grokSessions: () => privateHome };

    const command = create(AdoptImportedSessionSchema, {
      sourceKey: summary.sourceKey,
      snapshot: summary.snapshot,
      profileId: "fixture",
    });

    const sessionId = adoptImportedSession(service, homes, command);
    expect(adoptImportedSession(service, homes, command)).toBe(sessionId);
    const sessions = join(privateHome, "sessions");

    const rel = readdirSync(sessions, { recursive: true })
      .map(String)
      .find((p) => p.endsWith(`${sessionId}.jsonl`))!;

    const copy = join(sessions, rel);
    // This is an already-imported, unnormalized copy, as created before this fix.
    expect(readFileSync(copy, "utf8")).toContain('"model_provider":"cliproxyapi"');
    const fake = startFakeModel();
    writeFileSync(join(privateHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture" }));
    writeFileSync(join(privateHome, "config.toml"), `openai_base_url = ${JSON.stringify(`${fake.url}/v1`)}\n`);

    const profile = resolveProfiles([
      connection === "proxy"
        ? { kind: "cliproxyapi", id: "fixture", baseUrl: fake.url, apiKey: "fixture", providers: ["codex"] }
        : { kind: "native", id: "fixture", providers: ["codex"] },
    ]).find((p) => p.config.id === "fixture")!.resolved!;

    const env = { PATH: process.env["PATH"] ?? "", HOME: home, TMPDIR: process.env["TMPDIR"] ?? root };

    const spec = create(ThreadSpecSchema, {
      threadId: crypto.randomUUID(),
      provider: Provider.CODEX,
      providerProfileId: "fixture",
      providerThreadId: sessionId,
      cwd: join(home, "project"),
      model: "gpt-6.1-sol",
      permissionMode: PermissionMode.READ_ONLY,
    });

    const ask = async (text: string, repair = true) => {
      const events: ThreadEvent[] = [];
      const turnId = crypto.randomUUID();

      const program = Effect.gen(function* () {
        const threads = yield* CodexThreads;
        yield* threads.startTurn(spec, turnId, create(UserInputSchema, { text }));

        const finished = yield* Effect.gen(function* () {
          for (;;) {
            const done = events.find((event) => event.turnId === turnId && event.body.case === "turnFinished");

            if (done) return done;
            yield* Effect.sleep("20 millis");
          }
        }).pipe(Effect.timeout("15 seconds"));

        expect(finished.body.case === "turnFinished" && finished.body.value.outcome).toBe(TurnOutcome.COMPLETED);
      }).pipe(
        Effect.provide(
          CodexThreads.layer({
            profile: () => ({ ...profile, env }),
            importedResumePath: (current, provider) => {
              if (!repair) return undefined;

              const path = prepareImportedCodexResume(
                service.copyManifest("codex", current.providerProfileId, current.providerThreadId),
                privateHome,
                current.providerThreadId,
                provider,
              );

              expect(readFileSync(copy, "utf8")).not.toContain('"model_provider_id":"cliproxyapi"');
              expect(readFileSync(copy, "utf8")).toContain(`"model_provider":"${provider}"`);

              return path;
            },
            publish: (event) => events.push(event),
            interact: async () => create(InteractionResponseSchema, { allow: false }),
            callTool: async () => create(AgentToolResultSchema, { isError: true }),
            launch: codexAppServerLaunch([{ ...profile, env }], env, codex!, undefined, privateHome),
            clientVersion: "test",
          }).pipe(Layer.provide(Journal.layer(join(dataDir, "journal.db")))),
        ),
      );

      await Effect.runPromise(program);
    };

    try {
      if (validatesSavedProvider)
        await expect(ask("FIXTURE_REFUSED before the update", false)).rejects.toMatchObject({
          harness: true,
          message: expect.stringContaining("which is no longer configured"),
        });
      await ask("Did FIXTURE_RESUME work?");
      await ask("Remember FIXTURE_SECOND after restarting");
      const request = fake.requests.at(-1);
      expect(request).toContain("Run the shell tool for FIXTURE_TOOL");
      expect(request).toContain("Think hard [redacted]");
      expect(request).not.toContain("about FIXTURE_THINK");
      expect(request).toContain("FIXTURE_TOOL_OUTPUT");
      expect(request).toContain("FIXTURE_ANSWER FIXTURE_RESUME");
      expect(request).toContain("FIXTURE_SECOND");
      expect(readFileSync(copy, "utf8")).toContain("FIXTURE_SECOND");
      expect(treeFingerprint(sourceHome)).toBe(before);
      removeCopy(service.copyManifest("codex", "fixture", sessionId), privateHome);
      expect(await Bun.file(copy).exists()).toBe(false);
    } finally {
      await fake.stop();
    }
  },
  60_000,
);
