import { expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AdoptImportedSessionSchema,
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  UserInputSchema,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer } from "effect";
import { Journal } from "../journal/index.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { adoptImportedSession } from "./adopt.ts";
import { startFakeModel } from "./fixtures/fake-model.ts";
import { installFixtureHome, treeFingerprint } from "./fixtures/install.ts";
import { WorkerImport } from "./service.ts";

/**
 * Native continue with the real Codex app-server (docs/import.md, "Codex"): an imported rollout copied into the
 * private CODEX_HOME resumes (thread/resume by its id), and the model gets its history. The fake endpoint stands in
 * for the model: no credentials, no inference. Opt-in live tests repeat this against the real API.
 */

const temp = tempDirs();

test.skipIf(!Bun.which("codex"))(
  "the real Codex resumes an imported rollout from Canopy's private home",
  async () => {
    const root = temp("canopy-import-codex-resume-");
    const home = join(root, "home");
    const dataDir = join(root, "data");
    installFixtureHome(home, ["codex"]);
    // A value the worker knows as a secret, which the rollout contains: the resumed model must not see it.
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ token: "about FIXTURE_THINK" }));

    const service = new WorkerImport({
      dataDir,
      homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
      config: () => undefined,
    });

    const before = treeFingerprint(join(home, ".codex"));
    const summary = (await service.scan(["codex"])).threads.find((t) => t.cwd === join(home, "project"))!;
    const privateHome = join(dataDir, "codex-home");
    const homes = { claudeHome: () => privateHome, codexHome: () => privateHome };

    const adopt = () =>
      adoptImportedSession(
        service,
        homes,
        create(AdoptImportedSessionSchema, { sourceKey: summary.sourceKey, snapshot: summary.snapshot }),
      );

    const sessionId = adopt();
    // Adopting again keeps the same copy (a retried page or a resumed run).
    expect(adopt()).toBe(sessionId);

    const fake = startFakeModel();

    const answered = (async () => {
      const deadline = Date.now() + 25_000;

      while (!fake.requests.some((r) => r.includes("FIXTURE_RESUME")) && Date.now() < deadline) await Bun.sleep(100);
    })();

    const abort = new AbortController();

    const profile = resolveProfiles([
      { kind: "cliproxyapi", id: "fixture", baseUrl: fake.url, apiKey: "fixture", providers: ["codex"] },
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

    const program = Effect.gen(function* () {
      const threads = yield* CodexThreads;
      // Unknown to this app-server: it resumes the thread by id from its CODEX_HOME (thread/resume).
      yield* threads.startTurn(
        spec,
        crypto.randomUUID(),
        create(UserInputSchema, { text: "Did FIXTURE_RESUME work?" }),
      );
      yield* Effect.promise(() => answered);
    }).pipe(
      Effect.provide(
        CodexThreads.layer({
          profile: () => ({ ...profile, env }),
          publish: () => {},
          interact: async () => create(InteractionResponseSchema, { allow: false }),
          callTool: async () => create(AgentToolResultSchema, { isError: true }),
          launch: codexAppServerLaunch([{ ...profile, env }], env, Bun.which("codex")!, undefined, privateHome),
          clientVersion: "test",
        }).pipe(Layer.provide(Journal.layer(join(dataDir, "journal.db")))),
      ),
    );

    const running = Effect.runPromise(program, { signal: abort.signal }).catch(() => undefined);

    try {
      await answered;
      const request = fake.requests.find((r) => r.includes("FIXTURE_RESUME"));
      expect(request).toBeDefined();
      // The imported history reached the model: both earlier prompts and the tool output.
      expect(request).toContain("Run the shell tool for FIXTURE_TOOL");
      expect(request).toContain("Think hard [redacted]");
      expect(request).not.toContain("about FIXTURE_THINK");
      expect(request).toContain("FIXTURE_TOOL_OUTPUT");
    } finally {
      abort.abort();
      await running;
      await fake.stop();
    }

    // The user's CLI files are untouched; the turn went to Canopy's copy.
    expect(treeFingerprint(join(home, ".codex"))).toBe(before);
    const sessions = join(privateHome, "sessions");

    const copy = readdirSync(sessions, { recursive: true })
      .map(String)
      .find((p) => p.endsWith(`${sessionId}.jsonl`));

    expect(copy && (await Bun.file(join(sessions, copy)).text())).toContain("FIXTURE_RESUME");
  },
  60_000,
);
