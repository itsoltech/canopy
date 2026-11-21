import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentTool,
  AgentToolResultSchema,
  CommandSchema,
  GoalDirective,
  InteractionResponseSchema,
  Provider,
  SetGoalSchema,
  SteerTurnSchema,
  ThreadLifecycleSchema,
  ThreadSpecSchema,
} from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { cleanupFixture } from "../agent-tools/cleanup.test-support.ts";
import { AgentTools } from "../agent-tools/index.ts";
import { HeadTracker } from "../git/heads.ts";
import { Journal } from "../journal/index.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { HostContext } from "./host-context.ts";
import { WorkerHost } from "./host.ts";
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

test("unload fences a goal that was waiting for a CLI install when it reached the worker", async () => {
  const dir = tempDir("canopy-module-goal-admission-");
  const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
  const host = new WorkerHost({ runtime, dataDir: dir, clientVersion: "test" });
  const threadId = crypto.randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  host.cli.settled = async () => {
    entered.resolve();
    await release.promise;
  };

  const command = create(CommandSchema, {
    commandId: crypto.randomUUID(),
    kind: {
      case: "setGoal",
      value: {
        thread: { threadId, provider: Provider.CODEX },
        directive: GoalDirective.RUN,
        objective: "Held at CLI install",
      },
    },
  });

  const pending = host.handleCommand(command);

  try {
    await entered.promise;
    expect(
      await host.handleCommand(
        create(CommandSchema, {
          commandId: crypto.randomUUID(),
          kind: { case: "unloadThread", value: { threadId } },
        }),
      ),
    ).toMatchObject({ ok: true });
    release.resolve();
    expect(await pending).toMatchObject({ ok: false, errorCode: "THREAD_CLOSED" });
    expect(await host.handleCommand(command)).toMatchObject({ ok: false, errorCode: "THREAD_CLOSED" });
  } finally {
    release.resolve();
    await pending;
    await host.close();
    await runtime.dispose();
  }
});

test("worker reconnect and shutdown clean matching native sessions and retry only unfinished archives", async () => {
  const f = cleanupFixture();
  const runtime = ManagedRuntime.make(Journal.layer(join(f.dir, "journal.db")));
  const failedCleanup = Promise.withResolvers<void>();

  const host = new WorkerHost({
    runtime,
    dataDir: f.dir,
    clientVersion: "test",
    cliEnv: { HOME: f.dir, PATH: join(f.dir, "bin") },
    log: (message) => {
      if (message === "Thread resource cleanup will retry") failedCleanup.resolve();
    },
  });

  const failed = crypto.randomUUID();
  const managed = crypto.randomUUID();
  const healthy = crypto.randomUUID();
  const archived = [failed, managed, ...Array.from({ length: 64 }, () => crypto.randomUUID())];
  const snapshot = create(ThreadLifecycleSchema, { replace: true, closedThreadIds: archived });
  f.state(AgentTool.BROWSER, { sessions: { [failed]: [], [healthy]: [] }, failClose: true });
  f.state(AgentTool.DESKTOP, { sessions: { [managed]: [], [healthy]: [] } });
  f.state(AgentTool.DEVICE, { running: true, sessions: { [managed]: [], [healthy]: [] } });

  try {
    host.applyThreadLifecycle(snapshot);
    await failedCleanup.promise;
    expect(host.threadClosed(failed)).toBe(true);
    expect(f.read(AgentTool.DEVICE).sessions).toEqual({ [healthy]: [] });
    expect(f.calls().filter(({ args }) => args.includes("--version"))).toHaveLength(3);
    expect(f.calls().filter(({ args }) => args.includes("list"))).toHaveLength(3);
    expect(
      f
        .calls()
        .filter(({ args }) => args.includes("disable"))
        .map(({ args }) => args[1]),
    ).toEqual([managed]);
    expect(
      f
        .calls()
        .filter(({ tool, args }) => tool === "agent-device" && args.includes("close"))
        .map(({ args }) => args[2]),
    ).toEqual([managed]);

    // The durable unload ACK establishes that the successful thread finished before the next snapshot.
    expect(
      await host.handleCommand(
        create(CommandSchema, {
          commandId: crypto.randomUUID(),
          kind: { case: "unloadThread", value: { threadId: managed } },
        }),
      ),
    ).toMatchObject({ ok: true });

    const beforeReconnect = f.calls().length;
    f.state(AgentTool.BROWSER, { sessions: { [failed]: [], [healthy]: [] } });
    host.applyThreadLifecycle(snapshot);
    // Update shutdown waits for any cleanup that the repeated snapshot schedules.
    await host.shutdown();
    expect(f.read(AgentTool.BROWSER).sessions).toEqual({ [healthy]: [] });
    const retry = f.calls().slice(beforeReconnect);
    expect(retry.filter(({ args }) => args.includes("--version"))).toHaveLength(3);
    expect(retry.some(({ args }) => args.includes(managed))).toBe(false);
    expect(
      retry.filter(({ args }) => args.includes("session") && args.includes("list") && args.includes("--session")),
    ).toHaveLength(0);
  } finally {
    await host.close();
    await runtime.dispose();
  }
}, 20_000);
