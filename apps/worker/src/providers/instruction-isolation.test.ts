import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadEventSchema,
  ThreadSpecSchema,
  UserInputSchema,
  type ThreadSpec,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "../journal/index.ts";
import { ClaudeThreads } from "./claude/threads.ts";
import { CodexThreads } from "./codex/threads.ts";
import { codexAppServerLaunch } from "./codex/launch.ts";
import { GrokThreads } from "./grok/threads.ts";
import { DEFAULT_NATIVE_TOOL_POLICY } from "./native-tools.ts";
import { resolveProfiles, type ResolvedProfile } from "./profiles.ts";

const temp = tempDirs();

const globals = [
  "FIXTURE_GLOBAL_CLAUDE",
  "FIXTURE_GLOBAL_CODEX",
  "FIXTURE_GLOBAL_GROK",
  "FIXTURE_HOME_CLAUDE",
  "FIXTURE_HOME_AGENTS",
  "fixture-private-skill",
  "fixture-private-claude-skill",
  "fixture-private-codex-skill",
  "fixture-private-grok-skill",
  "FIXTURE_GLOBAL_CLAUDE_RULE",
];

const managed = "FIXTURE_MANAGED_LIBRARY";
const managedSkill = "fixture-managed-skill";
const projectRule = "FIXTURE_PROJECT_RULE";
const projectDirectoryRule = "FIXTURE_PROJECT_DIRECTORY_RULE";
const prompt = "FIXTURE_THREAD_INPUT";
const models = { claude: "claude-haiku-5-5", codex: "gpt-6.1-sol", grok: "fixture-grok" };

function fixture(name: string, project: boolean, assigned: boolean) {
  const root = temp("canopy-thread-instructions-");
  const home = join(root, "device [fixture]");
  const dataDir = join(home, "data");
  const isolated = join(dataDir, `${name}-home`);
  const workspace = join(home, "repo");
  const cwd = project ? join(workspace, "src") : join(dataDir, "scratch/owner/thread");

  for (const path of [
    isolated,
    cwd,
    ...[".claude", ".codex", ".grok", ".agents/skills/fixture-private-skill"].map((p) => join(home, p)),
  ])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), globals[0]!);
  writeFileSync(join(home, ".codex/AGENTS.md"), globals[1]!);
  writeFileSync(join(home, ".grok/AGENTS.md"), globals[2]!);
  writeFileSync(join(home, "CLAUDE.md"), globals[3]!);
  writeFileSync(join(home, "AGENTS.md"), globals[4]!);
  mkdirSync(join(home, ".claude/rules"), { recursive: true });
  writeFileSync(join(home, ".claude/rules/fixture.md"), "FIXTURE_GLOBAL_CLAUDE_RULE");
  writeFileSync(
    join(home, ".agents/skills/fixture-private-skill/SKILL.md"),
    "---\nname: fixture-private-skill\ndescription: Private fixture\n---\nPrivate user instructions\n",
  );

  for (const harness of ["claude", "codex", "grok"]) {
    const name = `fixture-private-${harness}-skill`;
    const path = join(home, `.${harness}`, "skills", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: Private fixture\n---\nPrivate instructions\n`,
    );
  }

  if (assigned)
    writeFileSync(
      join(isolated, name === "claude" ? "CLAUDE.md" : "AGENTS.md"),
      `<!-- canopy:agent-environment:begin -->\n${managed}\n<!-- canopy:agent-environment:end -->\n`,
    );

  if (assigned && name !== "claude") {
    const skills = join(isolated, "skills", managedSkill);
    mkdirSync(skills, { recursive: true });
    writeFileSync(
      join(skills, "SKILL.md"),
      `---\nname: ${managedSkill}\ndescription: Managed fixture\n---\nLibrary instructions\n`,
    );
  }

  if (project) {
    const git = Bun.spawnSync(["git", "init", "-q"], { cwd: workspace });
    expect(git.exitCode).toBe(0);
    writeFileSync(join(workspace, name === "claude" ? "CLAUDE.md" : "AGENTS.md"), projectRule);
    const rules = join(workspace, name === "grok" ? ".grok/rules" : ".claude/rules");
    mkdirSync(rules, { recursive: true });
    writeFileSync(join(rules, "fixture.md"), projectDirectoryRule);
  } else {
    // A scratch directory must stay bounded even when the data directory is inside a repository.
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: home }).exitCode).toBe(0);
  }

  return {
    home,
    dataDir,
    isolated,
    cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      GROK_HOME: join(home, ".grok"),
      TMPDIR: process.env["TMPDIR"] ?? root,
    },
  };
}

function startFixture(
  name: keyof typeof models,
  f: ReturnType<typeof fixture>,
  profile: ResolvedProfile,
  spec: ThreadSpec,
  seen: Promise<string>,
  signal: AbortSignal,
) {
  const input = create(UserInputSchema, { text: prompt });

  const common = {
    // Trust only the controlled Grok fixture. Production retains the CLI's folder trust gate.
    profile: () => ({ ...profile, env: { ...f.env, GROK_FOLDER_TRUST: "0" } }),
    publish: () => {},
    interact: async () => create(InteractionResponseSchema, { allow: false }),
    callTool: async () => create(AgentToolResultSchema, { isError: true }),
  };

  const wait = Effect.promise(() => seen);
  const journal = Journal.layer(join(f.dataDir, "journal.db"));

  if (name === "grok") {
    const threads = new GrokThreads({
      ...common,
      dataDir: f.dataDir,
      executable: Bun.which(name)!,
      linkDeviceLogin: false,
      record: async () => create(ThreadEventSchema),
    });

    return {
      done: threads.create(spec).then(() => threads.startTurn(spec, crypto.randomUUID(), input)),
      close: () => threads.close(),
    };
  }

  if (name === "claude") {
    const program = Effect.gen(function* () {
      const threads = yield* ClaudeThreads;
      yield* threads.create(spec);
      yield* threads.startTurn(spec, crypto.randomUUID(), input);
      yield* wait;
    }).pipe(
      Effect.provide(
        ClaudeThreads.layer({
          ...common,
          home: f.isolated,
          baseEnv: f.env,
          executable: Bun.which(name)!,
          nativeTools: DEFAULT_NATIVE_TOOL_POLICY,
        }).pipe(Layer.provide(journal)),
      ),
    );

    return { done: Effect.runPromise(program, { signal }), close: async () => {} };
  }

  const program = Effect.gen(function* () {
    const threads = yield* CodexThreads;
    const id = yield* threads.create(spec);
    yield* threads.startTurn(create(ThreadSpecSchema, { ...spec, providerThreadId: id }), crypto.randomUUID(), input);
    yield* wait;
  }).pipe(
    Effect.provide(
      CodexThreads.layer({
        ...common,
        launch: codexAppServerLaunch([profile], f.env, Bun.which(name)!, undefined, f.isolated),
        clientVersion: "test",
      }).pipe(Layer.provide(journal)),
    ),
  );

  return { done: Effect.runPromise(program, { signal }), close: async () => {} };
}

for (const [name, provider] of [
  ["claude", Provider.CLAUDE],
  ["codex", Provider.CODEX],
  ["grok", Provider.GROK],
] as const) {
  for (const [project, assigned] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    test.skipIf(!Bun.which(name))(
      `${name} ${project ? "project" : "scratch"} thread ${assigned ? "with" : "without"} managed instructions`,
      async () => {
        const f = fixture(name, project, assigned);
        const seen = Promise.withResolvers<string>();
        const captured: string[] = [];
        const abort = new AbortController();

        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async (request) => {
            if (
              request.method === "POST" &&
              /\/(messages|responses|chat\/completions)$/.test(new URL(request.url).pathname)
            ) {
              const body = await request.text();
              captured.push(body);

              if (body.includes(prompt) && body.includes('"tools":[{')) seen.resolve(body);
            }

            return Response.json(
              { type: "error", error: { type: "invalid_request_error", message: "fixture refuses inference" } },
              { status: 400 },
            );
          },
        });

        const profile = resolveProfiles([
          { kind: "cliproxyapi", id: "fixture", baseUrl: server.url.href, apiKey: "fixture", providers: [name] },
        ]).find((p) => p.config.id === "fixture")!.resolved!;

        const spec = create(ThreadSpecSchema, {
          threadId: crypto.randomUUID(),
          provider,
          providerProfileId: "fixture",
          cwd: f.cwd,
          scratch: !project,
          model: models[name],
          permissionMode: PermissionMode.READ_ONLY,
          // The instruction library currently targets Claude and Codex; Grok has thread instructions.
          ...(name === "grok" && assigned && { instructions: managed }),
        });

        const runtime = startFixture(name, f, profile, spec, seen.promise, abort.signal);

        const settled = runtime.done.catch((error: Error) => {
          seen.reject(error);
        });

        const timer = setTimeout(() => seen.reject(new Error("Official CLI did not send inference")), 20_000);

        try {
          const body = await seen.promise;

          // Inspect the entire request: Claude delivers memory as user context, not only system text.
          for (const marker of globals) expect(body.includes(marker), `Global context leaked: ${marker}`).toBe(false);
          expect(body.includes(managed)).toBe(assigned);
          expect(body.includes(projectRule)).toBe(project);

          if (name !== "codex") expect(body.includes(projectDirectoryRule)).toBe(project);

          if (name !== "claude") expect(body.includes(managedSkill)).toBe(assigned);

          for (const marker of globals)
            expect(
              captured.some((text) => text.includes(marker)),
              `Global context leaked: ${marker}`,
            ).toBe(false);
        } finally {
          clearTimeout(timer);
          abort.abort();
          await runtime.close();
          await settled;
          await server.stop(true);
        }
      },
      30_000,
    );
  }
}
