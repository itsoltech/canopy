/**
 * The worker's command handling over the real gRPC link (WorkerHost + serveLink, the code main.ts runs).
 * No provider processes: Codex and Claude are disabled in the configuration.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { create } from "@bufbuild/protobuf";
import {
  BackgroundTaskKind,
  CommandSchema,
  ItemStatus,
  PermissionMode,
  Provider,
  TurnEndSource,
  TurnOrigin,
  TurnOutcome,
} from "@canopy/contracts";
import type { WorkerConnection } from "@canopy/gateway/worker-link";
import { tempDir } from "@canopy/testing";
import { journalHello } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { connectWorker, startGateway } from "./helpers.ts";

const dir = tempDir("canopy-host-");
const root = join(dir, "repos");

mkdirSync(join(root, "project-a", ".git"), { recursive: true });

mkdirSync(join(root, "notes"), { recursive: true });

let gateway: Awaited<ReturnType<typeof startGateway>>;
let connection: WorkerConnection;
let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
let host: WorkerHost;

beforeAll(async () => {
  gateway = await startGateway();
  runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
  // Full access turned off in worker.json: its turns are refused before any provider runs.
  host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "test", fullAccess: false });

  const link = await connectWorker(gateway.server.url, {
    hello: { workerId: "worker-1", ...(await runtime.runPromise(journalHello())) },
  });

  void serveLink(link, host, runtime);
  connection = await gateway.nextConnection();
});

afterAll(async () => {
  await gateway.link.shutdown();
  await gateway.server.close();
  await host.close();
  await runtime.dispose();
});

const thread = (cwd: string, provider = Provider.CODEX) => ({
  threadId: Bun.randomUUIDv7(),
  provider,
  cwd,
  permissionMode: PermissionMode.ASK,
});

describe("worker command handling", () => {
  test("before any configuration: commands fail as not configured (and are not remembered)", async () => {
    const result = await connection.sendCommand({ case: "createThread", value: { thread: thread(root) } });
    expect(result).toMatchObject({ ok: false, errorCode: "WORKER_NOT_CONFIGURED" });
  });

  test("configuration with legacy roots is accepted; browse home and any existing absolute directory", async () => {
    connection.send({
      case: "config",
      value: { version: 1n, allowedRoots: [root], claude: { enabled: false }, codex: { enabled: false } },
    });

    for await (const message of connection.messages) {
      if (message.payload.case === "configApplied") {
        expect(message.payload.value.applied).toBe(true);
        break;
      }
    }

    const roots = await connection.sendCommand({ case: "listDirectory", value: { path: "" } });
    expect(roots).toMatchObject({ ok: true, directoryPath: homedir() });
    const listing = await connection.sendCommand({ case: "listDirectory", value: { path: root } });
    expect(listing.entries.map((e) => [e.name, e.isDir, e.isGitRepo])).toEqual([
      ["notes", true, false],
      ["project-a", true, true],
    ]);
    const outside = await connection.sendCommand({ case: "listDirectory", value: { path: "/" } });
    expect(outside).toMatchObject({ ok: true, directoryPath: "/" });
    expect(
      await connection.sendCommand({ case: "listDirectory", value: { path: join(dir, "missing") } }),
    ).toMatchObject({ ok: false, errorCode: "CWD_NOT_FOUND" });
    expect(await connection.sendCommand({ case: "listDirectory", value: { path: "relative" } })).toMatchObject({
      ok: false,
      errorCode: "CWD_NOT_ABSOLUTE",
    });
  });

  test("directory queries resolve every unambiguous segment and return disk spelling", async () => {
    const home = join(dir, "case-home");
    const apps = join(home, "GIT", "Canopy", "Apps");
    mkdirSync(apps, { recursive: true });
    mkdirSync(join(apps, "Web"));
    const list = (path: string) => connection.sendCommand({ case: "listDirectory", value: { path } });

    for (const path of [apps, join(home, "git", "canopy", "apps") + "/"]) {
      const result = await list(path);
      expect(result).toMatchObject({ ok: true, directoryPath: realpathSync(apps) });
      expect(result.entries).toMatchObject([{ name: "Web", isDir: true }]);
    }

    expect(await list(join(home, "git", "missing"))).toMatchObject({
      ok: false,
      errorCode: "CWD_NOT_FOUND",
      errorMessage: "No such directory. Check the path or choose a directory.",
    });
    writeFileSync(join(home, "file"), "not a directory");
    expect(await list(join(home, "file"))).toMatchObject({ ok: false, errorCode: "CWD_NOT_DIRECTORY" });

    const privateParent = join(home, "private");
    const accessible = join(privateParent, "accessible");
    mkdirSync(accessible, { recursive: true });

    try {
      chmodSync(privateParent, 0o111);
      expect(await list(accessible)).toMatchObject({ ok: true, directoryPath: realpathSync(accessible) });
    } finally {
      chmodSync(privateParent, 0o700);
    }

    // Case-insensitive volumes cannot hold these two siblings; the queries above cover their native behavior.
    mkdirSync(join(home, "Git"), { recursive: true });

    if (!readdirSync(home).includes("Git")) return;

    for (const name of ["Git", "GIT"])
      expect(await list(join(home, name))).toMatchObject({
        ok: true,
        directoryPath: realpathSync(join(home, name)),
      });
    const ambiguous = await list(join(home, "git", "canopy", "apps"));
    expect(ambiguous).toMatchObject({ ok: false, errorCode: "CWD_AMBIGUOUS" });
    expect(ambiguous.errorMessage).toContain("“GIT”, “Git”");
    expect(ambiguous.errorMessage).toContain("Type an exact name.");
  });

  test("update draining leaves new work unacknowledged and retryable while reads remain available", async () => {
    const command = create(CommandSchema, {
      commandId: Bun.randomUUIDv7(),
      kind: { case: "createThread", value: { thread: thread(root) } },
    });

    host.setUpdateDraining(true);

    try {
      expect(await host.handleCommand(command)).toBeUndefined();
      expect(await runtime.runPromise(Journal.use((j) => j.commandResult(command.commandId)))).toBeUndefined();
      expect(await connection.sendCommand({ case: "listDirectory", value: { path: root } })).toMatchObject({
        ok: true,
      });
      expect(await host.updateIdle()).toBe(true);
    } finally {
      host.setUpdateDraining(false);
    }

    expect(await host.handleCommand(command)).toMatchObject({ ok: false, errorCode: "PROVIDER_UNAVAILABLE" });
  });

  test("threads: any existing directory reaches provider; missing directory fails before provider", async () => {
    expect(await connection.sendCommand({ case: "createThread", value: { thread: thread(dir) } })).toMatchObject({
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    expect(
      await connection.sendCommand({ case: "createThread", value: { thread: thread(join(root, "nope")) } }),
    ).toMatchObject({
      errorCode: "CWD_NOT_FOUND",
    });
    expect(
      await connection.sendCommand({ case: "createThread", value: { thread: thread(root, Provider.CLAUDE) } }),
    ).toMatchObject({
      errorCode: "PROVIDER_UNAVAILABLE",
    });

    const disabled = await connection.sendCommand({
      case: "createThread",
      value: { thread: thread(join(root, "project-a")) },
    });

    expect(disabled).toMatchObject({
      ok: false,
      errorCode: "PROVIDER_UNAVAILABLE",
      errorMessage: "disabled in configuration",
    });
  });

  test("Full access turned off on the device: its turns are refused, other modes reach the provider", async () => {
    const turn = (permissionMode: PermissionMode) =>
      connection.sendCommand({
        case: "startTurn",
        value: {
          thread: thread(join(root, "project-a")),
          turnId: Bun.randomUUIDv7(),
          input: { text: "x" },
          permissionMode,
        },
      });

    expect(await turn(PermissionMode.FULL_ACCESS)).toMatchObject({ ok: false, errorCode: "FULL_ACCESS_DISABLED" });
    expect(await turn(PermissionMode.FULL_AUTO)).toMatchObject({ ok: false, errorCode: "PROVIDER_UNAVAILABLE" });
  });

  test("a fork at a turn without its provider ref is refused, never a copy of the whole history", async () => {
    const fork = {
      sourceThreadId: Bun.randomUUIDv7(),
      sourceProviderThreadId: "source",
      afterTurnId: Bun.randomUUIDv7(),
      afterProviderTurnRef: "",
    };

    const result = await connection.sendCommand({
      case: "createThread",
      value: { thread: thread(join(root, "project-a")), fork },
    });

    expect(result).toMatchObject({ ok: false, errorCode: "FORK_POINT_UNKNOWN" });
  });

  test("CreateThread prepares private scratch in worker data; an existing cwd under a previous data dir stays valid", async () => {
    const suffix = join("scratch", Bun.randomUUIDv7(), Bun.randomUUIDv7());
    const cwd = join(dir, "data", suffix);

    const result = await connection.sendCommand({
      case: "createThread",
      value: { thread: { ...thread(cwd), scratch: true } },
    });

    // Provider is intentionally disabled, but placement has succeeded before that boundary.
    expect(result.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(existsSync(cwd)).toBe(true);
    const outside = join(dir, suffix);
    expect(
      (await connection.sendCommand({ case: "createThread", value: { thread: { ...thread(outside), scratch: true } } }))
        .errorCode,
    ).toBe("SCRATCH_NOT_ALLOWED");
    expect(existsSync(outside)).toBe(false);
    const previous = join(root, "old-data", suffix);
    mkdirSync(previous, { recursive: true });
    expect(
      (
        await connection.sendCommand({
          case: "createThread",
          value: { thread: { ...thread(previous), scratch: true } },
        })
      ).errorCode,
    ).toBe("PROVIDER_UNAVAILABLE");
  });

  test("a redelivered command is answered from the journal, not executed again", async () => {
    const first = await connection.sendCommand({
      case: "createThread",
      value: { thread: thread(join(dir, "missing")) },
    });

    // Same command id again (what the gateway outbox does after a reconnect).
    const replay = await runtime.runPromise(Journal.use((j) => j.commandResult(first.commandId)));
    expect(replay).toMatchObject({ commandId: first.commandId, ok: false, errorCode: "CWD_NOT_FOUND" });
  });

  test("an interrupt for a turn this process does not run fails with TURN_NOT_RUNNING", async () => {
    const result = await connection.sendCommand({
      case: "interruptTurn",
      value: { threadId: Bun.randomUUIDv7(), turnId: Bun.randomUUIDv7() },
    });

    expect(result).toMatchObject({ ok: false, errorCode: "TURN_NOT_RUNNING" });
    expect(host.runningTurns()).toEqual([]);
  });
});

describe("worker restart", () => {
  test("turns of the previous process end as interrupted by the system (worker restarted mid-turn), once", async () => {
    const path = join(dir, "restart.db");
    const previous = ManagedRuntime.make(Journal.layer(path));
    // The previous process journaled a turn start and died before its end.
    await previous.runPromise(
      Journal.use((j) =>
        Effect.gen(function* () {
          yield* j.append("thread-a", {
            turnId: "turn-1",
            body: { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } },
          });
          yield* j.append("thread-a", { turnId: "turn-0", body: { case: "turnStarted", value: {} } });
          yield* j.append("thread-a", {
            turnId: "turn-0",
            body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } },
          });
        }),
      ),
    );
    await previous.dispose();
    const next = ManagedRuntime.make(Journal.layer(path));
    const restarted = new WorkerHost({ runtime: next, dataDir: join(dir, "data-restart"), clientVersion: "test" });
    expect(await restarted.recover()).toEqual({ turns: 1, tasks: 0, fromTranscript: 0 });
    const pending = await next.runPromise(Journal.use((j) => j.pending(new Map())));
    expect(pending.at(-1)).toMatchObject({
      threadId: "thread-a",
      turnId: "turn-1",
      body: {
        case: "turnFinished",
        value: { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.SYSTEM, reason: "worker restarted mid-turn" },
      },
    });
    expect(await restarted.recover()).toEqual({ turns: 0, tasks: 0, fromTranscript: 0 });
    expect(restarted.runningTurns()).toEqual([]);
    await restarted.close();
    await next.dispose();
  });

  test("a turn the harness finished while the worker was down ends the way its rollout says, with what was never forwarded", async () => {
    const path = join(dir, "restart-rollout.db");
    const rollout = join(import.meta.dir, "../../apps/worker/src/providers/fixtures/codex-rollout.jsonl");
    const previous = ManagedRuntime.make(Journal.layer(path));
    // The previous process forwarded the start, the user message and a running command, then died; Codex finished the
    // turn (the fixture's turn "turn-done": command output, final message, task_complete).
    await previous.runPromise(
      Journal.use((j) =>
        Effect.gen(function* () {
          yield* j.noteHarness("thread-b", "turn-b", {
            harness: "codex",
            transcript: rollout,
            sessionId: "c0dex-thread",
            offset: 0,
            providerTurn: "turn-done",
          });
          yield* j.append("thread-b", {
            turnId: "turn-b",
            body: { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } },
          });

          const user = {
            itemId: "user-item-1",
            status: ItemStatus.COMPLETED,
            content: { case: "userMessage" as const, value: { text: "Run sleep 2" } },
          };

          yield* j.append("thread-b", { turnId: "turn-b", body: { case: "itemCompleted", value: { item: user } } });

          const command = {
            itemId: "exec-cmd-1",
            status: ItemStatus.IN_PROGRESS,
            content: { case: "commandExecution" as const, value: { command: "sleep 2" } },
          };

          yield* j.append("thread-b", { turnId: "turn-b", body: { case: "itemStarted", value: { item: command } } });
        }),
      ),
    );
    await previous.dispose();
    const next = ManagedRuntime.make(Journal.layer(path));

    const restarted = new WorkerHost({
      runtime: next,
      dataDir: join(dir, "data-restart-rollout"),
      clientVersion: "test",
    });

    expect(await restarted.recover()).toEqual({ turns: 1, tasks: 0, fromTranscript: 1 });

    const pending = (await next.runPromise(Journal.use((j) => j.pending(new Map())))).filter(
      (e) => e.threadId === "thread-b",
    );

    const recovered = pending
      .slice(3)
      .map((e) => [
        e.body.case,
        e.body.case === "itemCompleted"
          ? `${e.body.value.item?.itemId}:${ItemStatus[e.body.value.item?.status ?? 0]}`
          : "",
      ]);

    // Only what the gateway does not have: the user message is not repeated.
    expect(recovered).toEqual([
      ["itemCompleted", "msg_commentary:COMPLETED"],
      ["itemCompleted", "call_cell_1:COMPLETED"],
      ["itemCompleted", "exec-cmd-1:COMPLETED"],
      ["itemCompleted", "msg_final:COMPLETED"],
      ["turnFinished", ""],
    ]);
    expect(pending.at(-1)?.body).toMatchObject({
      case: "turnFinished",
      value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: "turn-done" },
    });
    await restarted.close();
    await next.dispose();
  });

  test("background tasks a crash killed end as worker_lost, with their end time, once", async () => {
    const path = join(dir, "restart-tasks.db");
    const previous = ManagedRuntime.make(Journal.layer(path));
    await previous.runPromise(
      Journal.use((j) =>
        j.append("thread-c", { body: { case: "itemStarted", value: { item: task("bg:exec-9", "9") } } }),
      ),
    );
    await previous.dispose();
    const next = ManagedRuntime.make(Journal.layer(path));

    const restarted = new WorkerHost({
      runtime: next,
      dataDir: join(dir, "data-restart-tasks"),
      clientVersion: "test",
    });

    const before = Date.now();
    expect(await restarted.recover()).toEqual({ turns: 0, tasks: 1, fromTranscript: 0 });
    const ended = (await next.runPromise(Journal.use((j) => j.pending(new Map())))).at(-1);
    expect(ended?.body).toMatchObject({
      case: "itemCompleted",
      value: {
        item: {
          itemId: "bg:exec-9",
          status: ItemStatus.INTERRUPTED,
          content: { value: { stopReason: "worker_lost" } },
        },
      },
    });

    const content =
      ended?.body.case === "itemCompleted" && ended.body.value.item?.content.case === "backgroundTask"
        ? ended.body.value.item.content.value
        : undefined;

    expect(Number(content?.endedAt?.seconds ?? 0n) * 1000).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(content?.startedAt).toBeDefined(); // kept from the start
    expect(await restarted.recover()).toEqual({ turns: 0, tasks: 0, fromTranscript: 0 });
    await restarted.close();
    await next.dispose();
  });
});

const task = (itemId: string, taskId: string) => ({
  itemId,
  status: ItemStatus.IN_PROGRESS,
  content: {
    case: "backgroundTask" as const,
    value: {
      taskId,
      processId: taskId,
      kind: BackgroundTaskKind.PROCESS,
      command: "python3 train.py",
      startedAt: { seconds: 1_790_000_000n, nanos: 0 },
    },
  },
});

describe("graceful shutdown", () => {
  for (const kind of [BackgroundTaskKind.SHELL, BackgroundTaskKind.PROCESS]) {
    test(`a ${BackgroundTaskKind[kind]} terminal notification during teardown cannot win over worker_shutdown`, async () => {
      const journal = ManagedRuntime.make(Journal.layer(join(dir, `shutdown-order-${kind}.db`)));

      const item = {
        ...task("bg:shutdown-order", "42"),
        content: { case: "backgroundTask" as const, value: { ...task("", "").content.value, taskId: "42", kind } },
      };

      // Emulate the provider finalizer: Claude emits task_notification stopped; Codex can emit a failed
      // process exit as the app-server closes. Both reach the journal before the host closes orphan tasks.
      class TeardownHost extends WorkerHost {
        override async close() {
          await journal.runPromise(
            Journal.use((j) =>
              j.append("shutdown-order", {
                body: {
                  case: "itemCompleted",
                  value: {
                    item: {
                      ...item,
                      status: kind === BackgroundTaskKind.SHELL ? ItemStatus.INTERRUPTED : ItemStatus.FAILED,
                      content: { case: "backgroundTask", value: { ...item.content.value, stopReason: "stopped" } },
                    },
                  },
                },
              }),
            ),
          );
          await super.close();
        }
      }

      const stopping = new TeardownHost({
        runtime: journal,
        dataDir: join(dir, `shutdown-order-${kind}`),
        clientVersion: "test",
      });

      try {
        await journal.runPromise(
          Journal.use((j) => j.append("shutdown-order", { body: { case: "itemStarted", value: { item } } })),
        );
        expect(await stopping.shutdown()).toBe(1);

        const ends = (await journal.runPromise(Journal.use((j) => j.pending(new Map())))).filter(
          (e) => e.body.case === "itemCompleted",
        );

        expect(ends[0]?.body).toMatchObject({
          case: "itemCompleted",
          value: {
            item: {
              status: ItemStatus.INTERRUPTED,
              content: { case: "backgroundTask", value: { stopReason: "worker_shutdown", endedAt: expect.anything() } },
            },
          },
        });
        expect(await journal.runPromise(Journal.use((j) => j.openBackgroundTasks()))).toEqual([]);
      } finally {
        await journal.dispose();
      }
    });
  }

  test("running background tasks end as worker_shutdown with their end time, reported over the link before it closes", async () => {
    // A worker of its own (its own journal and link), with a task the (provider-less) runtime ran: the journal has it open.
    const journal = ManagedRuntime.make(Journal.layer(join(dir, "shutdown.db")));
    const stopping = new WorkerHost({ runtime: journal, dataDir: join(dir, "data-shutdown"), clientVersion: "test" });

    const link = await connectWorker(gateway.server.url, {
      hello: { workerId: "worker-1", ...(await journal.runPromise(journalHello())) },
    });

    void serveLink(link, stopping, journal);
    const peer = await gateway.nextConnection();
    const threadId = Bun.randomUUIDv7();
    await journal.runPromise(
      Journal.use((j) =>
        j.append(threadId, { body: { case: "itemStarted", value: { item: task("bg:exec-1", "4242") } } }),
      ),
    );

    const ack = (async () => {
      for await (const message of peer.messages) {
        if (message.payload.case !== "threadEvent") continue;
        const event = message.payload.value;
        peer.send({ case: "eventAck", value: { threadId: event.threadId, ackSeq: event.journalSeq } });
        const body = event.body;

        if (body.case === "itemCompleted" && body.value.item?.itemId === "bg:exec-1") return body.value.item;
      }

      return undefined;
    })();

    expect(await stopping.shutdown()).toBe(1);
    const ended = await ack;
    expect(ended).toMatchObject({
      status: ItemStatus.INTERRUPTED,
      content: { case: "backgroundTask", value: { taskId: "4242", stopReason: "worker_shutdown" } },
    });
    expect(ended?.content.case === "backgroundTask" && ended.content.value.endedAt).toBeTruthy();
    // Acked: nothing is left for the next process, which finds no task to close.
    expect(await stopping.flush(5_000)).toBe(true);
    // Commands after the stop get no answer: they stay in the gateway's outbox for the next process.
    expect(
      await stopping.handleCommand(
        create(CommandSchema, { commandId: Bun.randomUUIDv7(), kind: { case: "listDirectory", value: { path: "" } } }),
      ),
    ).toBeUndefined();
    expect(await journal.runPromise(Journal.use((j) => j.openBackgroundTasks()))).toEqual([]);
    expect(
      await new WorkerHost({
        runtime: journal,
        dataDir: join(dir, "data-after-shutdown"),
        clientVersion: "test",
      }).recover(),
    ).toMatchObject({ tasks: 0 });
    link.close();
    await journal.dispose();
  });
});
