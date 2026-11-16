import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  GoalDirective,
  InteractionResponseSchema,
  Provider,
  SetGoalSchema,
  SteerTurnSchema,
  ThreadSpecSchema,
} from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { AgentTools } from "../agent-tools/index.ts";
import { HeadTracker } from "../git/heads.ts";
import { Journal } from "../journal/index.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { HostContext } from "./host-context.ts";
import { HostState } from "./host-state.ts";

function fixture() {
  const root = tempDir("canopy-cleanup-admission-");
  const runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));
  const state = new HostState({ runtime, dataDir: join(root, "data"), clientVersion: "test" });
  state.agentTools = new AgentTools({
    dataDir: join(root, "data"),
    probe: { which: () => null },
    send: () => {},
    progress: () => {},
  });
  state.heads = new HeadTracker(() => {});
  const ctx = new HostContext(state, { applyConfig: async () => ({}), sendPreviews: () => {} });
  ctx.ops.reconcileRuntimes = async () => {};

  return { root, runtime, state, ctx };
}

test("a steer shell waiting for its journal lookup cannot start after archive and reopen", async () => {
  const f = fixture();
  const threadId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  f.state.cwds.set(threadId, f.root);
  f.state.running.add(`${threadId}/${turnId}`);
  const journal = await f.runtime.runPromise(Journal);
  const lookup = journal.shellInput;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  journal.shellInput = (id) =>
    Effect.promise(async () => {
      entered.resolve();
      await release.promise;
    }).pipe(Effect.flatMap(() => lookup(id)));

  const pending = f.ctx.ops
    .steerTurn(
      {
        case: "steerTurn",
        value: create(SteerTurnSchema, {
          threadId,
          turnId,
          inputId: crypto.randomUUID(),
          input: {
            shellInputId: crypto.randomUUID(),
            authorUserId: crypto.randomUUID(),
            shellCommand: "echo escaped > escaped-shell.txt",
          },
        }),
      },
      crypto.randomUUID(),
    )
    .catch((error: Error) => error);

  try {
    await entered.promise;
    f.state.closedThreads.add(threadId);
    await f.ctx.ops.releaseThread(threadId);
    f.state.closedThreads.delete(threadId);
    await f.ctx.ops.prepareThread(threadId);
    release.resolve();
    expect(await pending).toMatchObject({ code: "SHELL_INTERRUPTED" });
    expect(existsSync(join(f.root, "escaped-shell.txt"))).toBe(false);
    expect(await f.runtime.runPromise(Journal.use((j) => j.openShellInputs()))).toEqual([]);
  } finally {
    release.resolve();
    await pending;
    f.state.heads.close();
    f.state.secrets.close();
    await f.runtime.dispose();
  }
});

test("a goal waiting for runtime acquisition is fenced across archive and reopen", async () => {
  const f = fixture();
  const home = join(f.root, "home");
  mkdirSync(home);
  const trace = join(f.root, "trace.jsonl");
  const scope = await Effect.runPromise(Scope.make());
  const profile = resolveProfiles([{ id: "native", kind: "native", providers: ["codex"] }])[0]!.resolved!;

  const context = await f.runtime.runPromise(
    Layer.buildWithScope(
      CodexThreads.layer({
        clientVersion: "test",
        launch: {
          command: [process.execPath, resolve(import.meta.dir, "../providers/codex/fixtures/thread-release.ts")],
          env: { PATH: process.env["PATH"], CODEX_HOME: home, RELEASE_TRACE: trace, RELEASE_ROOT: f.root },
        },
        profile: () => profile,
        publish: () => {},
        interact: async () => create(InteractionResponseSchema),
        callTool: async () => create(AgentToolResultSchema),
      }),
      scope,
    ),
  );

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.ctx.ops.runCodex = async (_provider, use) => {
    entered.resolve();
    await release.promise;

    return f.runtime.runPromise(Effect.provide(CodexThreads.use(use), context));
  };

  const threadId = crypto.randomUUID();
  const spec = create(ThreadSpecSchema, { threadId, provider: Provider.CODEX, cwd: f.root });
  spec.providerThreadId = await f.runtime.runPromise(
    Effect.provide(
      CodexThreads.use((threads) => threads.create(spec)),
      context,
    ),
  );

  const pending = f.ctx.ops.setGoal({
    case: "setGoal",
    value: create(SetGoalSchema, {
      thread: spec,
      directive: GoalDirective.RUN,
      objective: "Do not restart archived work",
    }),
  });

  try {
    await entered.promise;
    f.state.closedThreads.add(threadId);
    const closing = f.ctx.ops.releaseThread(threadId);
    f.state.closedThreads.delete(threadId);
    release.resolve();
    await Promise.all([closing, pending]);
    await f.ctx.ops.prepareThread(threadId);
    expect(existsSync(trace) ? readFileSync(trace, "utf8") : "").not.toContain("thread/goal/set");
  } finally {
    release.resolve();
    await pending;
    f.state.heads.close();
    f.state.secrets.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await f.runtime.dispose();
  }
});
