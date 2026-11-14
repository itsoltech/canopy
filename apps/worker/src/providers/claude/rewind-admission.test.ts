import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  Provider,
  ThreadSpecSchema,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Effect, ManagedRuntime } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import type { ClaudeThreadContext } from "./thread-types.ts";
import { ClaudeUsage } from "./usage.ts";
import { claudeRuntime } from "./session-runtime.ts";
import { claudeSessions } from "./sessions.ts";
import { sessionOutput } from "./session-output.ts";
import { sessionTurns } from "./session-turns.ts";
import { consumeSession } from "./session-consumer.ts";
import { threadStart } from "./thread-commands.ts";
import { inputRecords } from "../../../../../tests/integration/fixtures/instance-probe.ts";

test("Claude cancels asynchronous session preparation before query creation and never caches the old session", async () => {
  const root = tempDir("canopy-claude-rewind-admission-");
  const home = join(root, "home");
  mkdirSync(home);
  const trace = join(root, "probe.jsonl");
  const runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));
  const events: ThreadEvent[] = [];
  const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["claude"] }])[0]!.resolved!;

  const ctx: ClaudeThreadContext = {
    usage: new ClaudeUsage(undefined),
    options: {
      home,
      executable: resolve(import.meta.dir, "../../../../../tests/integration/fixtures/instance-claude.ts"),
      baseEnv: { PATH: process.env["PATH"], INSTANCE_TRACE: trace },
      nativeTools: { nativeSubagents: false, nativeScheduling: false },
      profile: () => profile,
      publish: (event) => events.push(event),
      interact: async () => create(InteractionResponseSchema),
      callTool: async () => create(AgentToolResultSchema),
    },
    journal: await runtime.runPromise(Journal),
    sessions: new Map(),
    started: new Set(),
    resolvedModels: new Map(),
    modelEfforts: new Map(),
    shuttingDown: false,
  };

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let allowed = true;
  const output = sessionOutput(ctx);
  const turns = sessionTurns(ctx, output.record);

  const sessions = claudeSessions(
    ctx,
    {
      ...claudeRuntime(ctx),
      sessionExists: async () => {
        entered.resolve();
        await release.promise;

        return false;
      },
    },
    (session) => consumeSession(ctx, session, output, turns),
  );

  const commands = threadStart(ctx, sessions, turns, output.record);

  const spec = create(ThreadSpecSchema, {
    threadId: Bun.randomUUIDv7(),
    providerThreadId: Bun.randomUUIDv7(),
    cwd: root,
    provider: Provider.CLAUDE,
    enableAgentBus: true,
  });

  const staleSession = spec.providerThreadId;
  const staleTurn = Bun.randomUUIDv7();

  const starting = Effect.runPromise(
    commands.startTurn(spec, staleTurn, create(UserInputSchema, { text: "STALE" }), {
      model: "",
      effort: "",
      canSubmit: () => allowed,
    }),
  );

  try {
    await entered.promise;
    expect(events.some((event) => event.turnId === staleTurn)).toBe(false);
    allowed = false;
    release.resolve();
    await starting;
    expect(ctx.sessions.size).toBe(0);
    expect(existsSync(trace)).toBe(false);
    spec.providerThreadId = Bun.randomUUIDv7();
    const next = Bun.randomUUIDv7();
    await Effect.runPromise(commands.startTurn(spec, next, create(UserInputSchema, { text: "EDITED" })));
    await Effect.runPromise(
      Effect.gen(function* () {
        while (!events.some((event) => event.turnId === next && event.body.case === "turnFinished"))
          yield* Effect.sleep("5 millis");
      }).pipe(Effect.timeout("5 seconds")),
    );
    expect(inputRecords(trace).flatMap((record) => record.parts.map((part) => part.text))).toEqual(["EDITED"]);
    expect(existsSync(join(home, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), `${staleSession}.jsonl`))).toBe(false);
  } finally {
    release.resolve();
    await starting;

    for (const session of ctx.sessions.values()) {
      session.abort.abort();
      session.query.close();
    }

    await Promise.all([...ctx.sessions.values()].map((session) => session.done));
    await runtime.dispose();
  }
});
