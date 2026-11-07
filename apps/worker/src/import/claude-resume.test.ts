import { expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
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
import { ClaudeThreads } from "../providers/claude/threads.ts";
import { DEFAULT_NATIVE_TOOL_POLICY } from "../providers/native-tools.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { adoptImportedSession } from "./adopt.ts";
import { startFakeModel } from "./fixtures/fake-model.ts";
import { installFixtureHome, treeFingerprint } from "./fixtures/install.ts";
import { WorkerImport } from "./service.ts";

/**
 * Native continue with the real Claude Code (docs/import.md, "Kontynuacja"): an imported session copied into the
 * private home resumes, and the model gets its history. The fake endpoint stands in for the model: no credentials,
 * no inference. Opt-in live tests repeat this against the real API.
 */

const temp = tempDirs();

test.skipIf(!Bun.which("claude"))(
  "the real Claude Code resumes an imported session from Canopy's private home",
  async () => {
    const root = temp("canopy-import-claude-resume-");
    const home = join(root, "home");
    const dataDir = join(root, "data");
    installFixtureHome(home, ["claude"]);
    // A value the worker knows as a secret, which the session contains: the resumed model must not see it.
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ token: "with FIXTURE_AFTER" }));

    const service = new WorkerImport({
      dataDir,
      homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
      config: () => undefined,
    });

    const before = treeFingerprint(join(home, ".claude"));
    const summary = (await service.scan(["claude"])).threads.find((t) => t.cwd === join(home, "project"))!;
    const privateHome = join(dataDir, "claude-home");
    const homes = { claudeHome: () => privateHome };

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
      { kind: "cliproxyapi", id: "fixture", baseUrl: fake.url, apiKey: "fixture", providers: ["claude"] },
    ]).find((p) => p.config.id === "fixture")!.resolved!;

    const env = { PATH: process.env["PATH"] ?? "", HOME: home, TMPDIR: process.env["TMPDIR"] ?? root };

    const spec = create(ThreadSpecSchema, {
      threadId: crypto.randomUUID(),
      provider: Provider.CLAUDE,
      providerProfileId: "fixture",
      providerThreadId: sessionId,
      cwd: join(home, "project"),
      model: "claude-sonnet-4-5",
      permissionMode: PermissionMode.READ_ONLY,
    });

    const program = Effect.gen(function* () {
      const threads = yield* ClaudeThreads;
      yield* threads.create(spec);
      yield* threads.startTurn(
        spec,
        crypto.randomUUID(),
        create(UserInputSchema, { text: "Did FIXTURE_RESUME work?" }),
      );
      // The runtime lives as long as this program: wait for the resumed turn's request.
      yield* Effect.promise(() => answered);
    }).pipe(
      Effect.provide(
        ClaudeThreads.layer({
          profile: () => ({ ...profile, env }),
          publish: () => {},
          interact: async () => create(InteractionResponseSchema, { allow: false }),
          callTool: async () => create(AgentToolResultSchema, { isError: true }),
          home: privateHome,
          baseEnv: env,
          executable: Bun.which("claude")!,
          nativeTools: DEFAULT_NATIVE_TOOL_POLICY,
        }).pipe(Layer.provide(Journal.layer(join(dataDir, "journal.db")))),
      ),
    );

    const running = Effect.runPromise(program, { signal: abort.signal }).catch(() => undefined);

    try {
      await answered;
      const request = fake.requests.find((r) => r.includes("FIXTURE_RESUME"));
      expect(request).toBeDefined();
      // The imported history reached the model as Claude replays it: the compaction summary and the turns after it.
      expect(request).toContain("This session is being continued from a previous conversation");
      expect(request).toContain("Continue after compaction [redacted]");
      expect(request).not.toContain("with FIXTURE_AFTER");
    } finally {
      abort.abort();
      await running;
      await fake.stop();
    }

    // The user's CLI files are untouched; the turn went to Canopy's copy.
    expect(treeFingerprint(join(home, ".claude"))).toBe(before);
    const projects = join(privateHome, "projects");

    const copy = readdirSync(projects)
      .map((d) => join(projects, d, `${sessionId}.jsonl`))
      .find(existsSync);

    expect(copy && (await Bun.file(copy).text())).toContain("FIXTURE_RESUME");
  },
  60_000,
);
