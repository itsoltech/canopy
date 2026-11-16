import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  ForkSpecSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
  type ThreadEvent,
  type ThreadSpec,
  type ForkSpec,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startFakeModel } from "../import/fixtures/fake-model.ts";
import { Journal } from "../journal/index.ts";
import { ClaudeThreads } from "./claude/threads.ts";
import { spawnClaude } from "./claude/spawn.ts";
import { codexAppServerLaunch } from "./codex/launch.ts";
import { CodexThreads } from "./codex/threads.ts";
import { GrokThreads } from "./grok/threads.ts";
import { decodeJsonObject, jsonObject } from "./json.ts";
import { DEFAULT_NATIVE_TOOL_POLICY } from "./native-tools.ts";
import { resolveProfiles, type ResolvedProfile, type Env } from "./profiles.ts";

const temp = tempDirs();

type Harness = "claude" | "codex" | "grok";

/** Real provider sessions and requests, with local scripted inference and private homes. */
async function send(
  name: Harness,
  root: string,
  env: Env,
  profile: ResolvedProfile,
  spec: ThreadSpec,
  text: string,
  fork?: ForkSpec,
) {
  const events: ThreadEvent[] = [];

  const turnId = crypto.randomUUID();
  const input = create(UserInputSchema, { text });

  const common = {
    profile: () => profile,
    publish: (event: ThreadEvent) => events.push(event),
    interact: async () => create(InteractionResponseSchema, { allow: false }),
    callTool: async () => create(AgentToolResultSchema, { isError: true }),
  };

  if (name === "grok") {
    const journal = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));

    const threads = new GrokThreads({
      ...common,
      dataDir: root,
      executable: Bun.which(name)!,
      linkDeviceLogin: false,
      record: async (threadId, init) => {
        const event = await journal.runPromise(Journal.use((store) => store.append(threadId, init)));
        events.push(event);

        return event;
      },
    });

    try {
      spec.providerThreadId ||= await threads.create(spec);
      await threads.startTurn(spec, turnId, input);
    } finally {
      await threads.close();
      await journal.dispose();
    }
  } else {
    const run = (threads: ClaudeThreads["Service"] | CodexThreads["Service"]) =>
      Effect.gen(function* () {
        if (!spec.providerThreadId) spec.providerThreadId = yield* threads.create(spec, fork);

        yield* threads.startTurn(spec, turnId, input);

        while (!events.some((event) => event.turnId === turnId && event.body.case === "turnFinished"))
          yield* Effect.sleep("10 millis");
      });

    const journal = Journal.layer(join(root, "journal.db"));

    const program =
      name === "claude"
        ? ClaudeThreads.use(run).pipe(
            Effect.provide(
              ClaudeThreads.layer({
                ...common,
                home: join(root, "claude-home"),
                baseEnv: env,
                executable: Bun.which(name)!,
                nativeTools: DEFAULT_NATIVE_TOOL_POLICY,
              }).pipe(Layer.provide(journal)),
            ),
          )
        : CodexThreads.use(run).pipe(
            Effect.provide(
              CodexThreads.layer({
                ...common,
                launch: codexAppServerLaunch([profile], env, Bun.which(name)!, undefined, join(root, "codex-home")),
                clientVersion: "test",
              }).pipe(Layer.provide(journal)),
            ),
          );

    await Effect.runPromise(program.pipe(Effect.timeout("20 seconds")));
  }

  const finished = events.find((event) => event.turnId === turnId && event.body.case === "turnFinished");
  expect(finished?.body.case === "turnFinished" && finished.body.value).toMatchObject({
    outcome: TurnOutcome.COMPLETED,
    reason: "",
  });
}

function currentInstructions(name: Harness, raw: string): string {
  const body = decodeJsonObject(JSON.parse(raw));

  if (name === "claude") return JSON.stringify(body["system"]);
  const entries = body[name === "codex" ? "input" : "messages"];

  if (!Array.isArray(entries)) throw new Error("The harness did not send messages");
  const role = name === "codex" ? "developer" : "user";
  const messages = entries.filter((entry) => jsonObject(entry)?.["role"] === role);

  if (name === "codex") return JSON.stringify(messages);

  return JSON.stringify(
    messages.findLast((entry) => {
      const message = jsonObject(entry);

      return JSON.stringify(message?.["content"]).includes("Canopy thread instructions:");
    }),
  );
}

function expectReportingRules(instructions: string) {
  expect(instructions).toContain("default to working silently until your final answer");
  expect(instructions).toContain("identify the concrete action the recipient must take before you finish");
  expect(instructions).toContain("Do not send progress reports");
  expect(instructions).toContain("Use notify: false for mid-task messages to your parent");
}

function fixture(name: Harness, provider: Provider, modelId: string) {
  const root = temp(`canopy-${name}-reply-instructions-`);
  const cwd = join(root, "workspace");

  mkdirSync(cwd);
  mkdirSync(join(root, "claude-home"));
  mkdirSync(join(root, "codex-home"));

  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    TMPDIR: process.env["TMPDIR"] ?? root,
  };

  const model = startFakeModel();

  const resolved = resolveProfiles([
    { id: "fixture", kind: "cliproxyapi", baseUrl: model.url, apiKey: "fixture", providers: [name] },
  ]).find((entry) => entry.config.id === "fixture")!.resolved!;

  // Only this empty fixture workspace bypasses Grok's folder trust prompt.
  const profile = { ...resolved, env: { ...env, GROK_FOLDER_TRUST: "0" } };

  const spec = create(ThreadSpecSchema, {
    threadId: crypto.randomUUID(),
    provider,
    providerProfileId: "fixture",
    model: modelId,
    cwd,
    permissionMode: PermissionMode.READ_ONLY,
  });

  return { root, env, model, profile, spec };
}

for (const [name, provider, modelId] of [
  ["claude", Provider.CLAUDE, "claude-haiku-5-5"],
  ["codex", Provider.CODEX, "gpt-6.1-sol"],
  ["grok", Provider.GROK, "fixture-grok"],
] as const)
  test.skipIf(!Bun.which(name))(
    `${name} keeps reply instructions and conversation history after a cold resume`,
    async () => {
      const { root, env, model, profile, spec } = fixture(name, provider, modelId);

      try {
        for (const phase of ["FIRST", "RESUMED"]) {
          spec.instructions = `FIXTURE_THREAD_RULE_${phase}`;
          await send(name, root, env, profile, spec, `Remember FIXTURE_REPLY_${phase}`);
          const request = model.requests.at(-1)!;
          const instructions = currentInstructions(name, request);
          expect(instructions).toContain("[Create the PR](canopy:reply)");
          expect(instructions.includes(spec.instructions)).toBe(true);
          expect(instructions).toContain("Do all work already authorized");
          expect(instructions).toContain('delivery: \\"steer\\"');
          expect(instructions).toContain("finish without another user-facing message");
          expectReportingRules(instructions);

          if (phase === "RESUMED") expect(request).toContain("FIXTURE_REPLY_FIRST");
        }
      } finally {
        await model.stop();
      }
    },
    60_000,
  );

test.skipIf(!Bun.which("claude"))(
  "Claude replaces a legacy recorded append on resume without losing conversation history",
  async () => {
    const { root, env, model, profile, spec } = fixture("claude", Provider.CLAUDE, "claude-haiku-5-5");

    try {
      const legacy = query({
        prompt: "Remember FIXTURE_REPLY_LEGACY",
        options: {
          cwd: spec.cwd,
          sessionId: spec.threadId,
          model: spec.model,
          env: {
            ...env,
            CLAUDE_CONFIG_DIR: join(root, "claude-home"),
            ANTHROPIC_BASE_URL: model.url,
            ANTHROPIC_API_KEY: "fixture",
          },
          pathToClaudeCodeExecutable: Bun.which("claude")!,
          spawnClaudeCodeProcess: spawnClaude,
          settingSources: [],
          strictMcpConfig: true,
          systemPrompt: { type: "preset", preset: "claude_code", append: "FIXTURE_LEGACY_APPEND", snapshot: true },
        },
      });

      for await (const _message of legacy) {
        /* Persist the old prompt snapshot and its real conversation before opening the worker adapter. */
      }

      expect(currentInstructions("claude", model.requests.at(-1)!)).toContain("FIXTURE_LEGACY_APPEND");
      spec.providerThreadId = spec.threadId;
      spec.instructions = "FIXTURE_CURRENT_APPEND";
      await send("claude", root, env, profile, spec, "Continue FIXTURE_REPLY_CURRENT");
      const request = model.requests.at(-1)!;
      const instructions = currentInstructions("claude", request);
      expect(instructions.includes("FIXTURE_CURRENT_APPEND")).toBe(true);
      expect(instructions.includes("FIXTURE_LEGACY_APPEND")).toBe(false);
      expect(instructions).toContain("[Create the PR](canopy:reply)");
      expectReportingRules(instructions);
      expect(request).toContain("FIXTURE_REPLY_LEGACY");
    } finally {
      await model.stop();
    }
  },
  30_000,
);

test.skipIf(!Bun.which("codex"))(
  "Codex adds current reply instructions to a fork while keeping the source history",
  async () => {
    const { root, env, model, profile, spec } = fixture("codex", Provider.CODEX, "gpt-6.1-sol");

    try {
      await send("codex", root, env, profile, spec, "Remember FIXTURE_FORK_SOURCE");
      const fork = create(ForkSpecSchema, { sourceProviderThreadId: spec.providerThreadId });

      const child = create(ThreadSpecSchema, {
        ...spec,
        threadId: crypto.randomUUID(),
        providerThreadId: "",
        instructions: "FIXTURE_FORK_INSTRUCTIONS",
      });

      await send("codex", root, env, profile, child, "Continue FIXTURE_FORK_CHILD", fork);
      const request = model.requests.at(-1)!;
      expect(currentInstructions("codex", request)).toContain("FIXTURE_FORK_INSTRUCTIONS");
      expect(currentInstructions("codex", request)).toContain("[Create the PR](canopy:reply)");
      expectReportingRules(currentInstructions("codex", request));
      expect(request).toContain("FIXTURE_FORK_SOURCE");
      expect(child.providerThreadId).not.toBe(spec.providerThreadId);
    } finally {
      await model.stop();
    }
  },
  30_000,
);
