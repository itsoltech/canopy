/**
 * The worker's command handling over the real gRPC link (WorkerHost + serveLink, the code main.ts runs).
 * No provider processes: Codex and Claude are disabled in the configuration.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ItemStatus, PermissionMode, Provider, TurnEndSource, TurnOrigin, TurnOutcome } from "@open-agents/contracts";
import type { WorkerConnection } from "@open-agents/gateway/worker-link";
import { journalHello } from "@open-agents/worker/gateway-link";
import { Journal } from "@open-agents/worker/journal";
import { serveLink, WorkerHost } from "@open-agents/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { connectWorker, startGateway } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "oa-host-"));
const root = join(dir, "repos");
mkdirSync(join(root, "project-a", ".git"), { recursive: true });
mkdirSync(join(root, "notes"), { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let gateway: Awaited<ReturnType<typeof startGateway>>;
let connection: WorkerConnection;
let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
let host: WorkerHost;

beforeAll(async () => {
  gateway = await startGateway();
  runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
  host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "test" });
  const link = await connectWorker(gateway.server.url, { hello: { workerId: "worker-1", ...(await runtime.runPromise(journalHello())) } });
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

  test("configuration arrives, then directories can be browsed inside the allowed roots", async () => {
    connection.send({ case: "config", value: { version: 1n, allowedRoots: [root], claude: { enabled: false }, codex: { enabled: false } } });
    for await (const message of connection.messages) {
      if (message.payload.case === "configApplied") {
        expect(message.payload.value.applied).toBe(true);
        break;
      }
    }
    const roots = await connection.sendCommand({ case: "listDirectory", value: { path: "" } });
    expect(roots.entries.map((e) => [e.name, e.isDir])).toEqual([[root, true]]);
    const listing = await connection.sendCommand({ case: "listDirectory", value: { path: root } });
    expect(listing.entries.map((e) => [e.name, e.isDir, e.isGitRepo])).toEqual([
      ["notes", true, false],
      ["project-a", true, true],
    ]);
    const outside = await connection.sendCommand({ case: "listDirectory", value: { path: "/" } });
    expect(outside).toMatchObject({ ok: false, errorCode: "CWD_NOT_ALLOWED" });
  });

  test("threads: directory outside the roots, missing directory, unsupported and disabled providers", async () => {
    expect(await connection.sendCommand({ case: "createThread", value: { thread: thread(dir) } })).toMatchObject({ errorCode: "CWD_NOT_ALLOWED" });
    expect(await connection.sendCommand({ case: "createThread", value: { thread: thread(join(root, "nope")) } })).toMatchObject({
      errorCode: "CWD_NOT_FOUND",
    });
    expect(await connection.sendCommand({ case: "createThread", value: { thread: thread(root, Provider.CLAUDE) } })).toMatchObject({
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    const disabled = await connection.sendCommand({ case: "createThread", value: { thread: thread(join(root, "project-a")) } });
    expect(disabled).toMatchObject({ ok: false, errorCode: "PROVIDER_UNAVAILABLE", errorMessage: "disabled in configuration" });
  });

  test("a fork at a turn without its provider ref is refused, never a copy of the whole history", async () => {
    const fork = { sourceThreadId: Bun.randomUUIDv7(), sourceProviderThreadId: "source", afterTurnId: Bun.randomUUIDv7(), afterProviderTurnRef: "" };
    const result = await connection.sendCommand({ case: "createThread", value: { thread: thread(join(root, "project-a")), fork } });
    expect(result).toMatchObject({ ok: false, errorCode: "FORK_POINT_UNKNOWN" });
  });

  test("a redelivered command is answered from the journal, not executed again", async () => {
    const first = await connection.sendCommand({ case: "createThread", value: { thread: thread(dir) } });
    // Same command id again (what the gateway outbox does after a reconnect).
    const replay = await runtime.runPromise(Journal.use((j) => j.commandResult(first.commandId)));
    expect(replay).toMatchObject({ commandId: first.commandId, ok: false, errorCode: "CWD_NOT_ALLOWED" });
  });

  test("an interrupt for a turn this process does not run fails with TURN_NOT_RUNNING", async () => {
    const result = await connection.sendCommand({ case: "interruptTurn", value: { threadId: Bun.randomUUIDv7(), turnId: Bun.randomUUIDv7() } });
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
          yield* j.append("thread-a", { turnId: "turn-1", body: { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } } });
          yield* j.append("thread-a", { turnId: "turn-0", body: { case: "turnStarted", value: {} } });
          yield* j.append("thread-a", { turnId: "turn-0", body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } } });
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
      body: { case: "turnFinished", value: { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.SYSTEM, reason: "worker restarted mid-turn" } },
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
          yield* j.noteHarness("thread-b", "turn-b", { harness: "codex", transcript: rollout, sessionId: "c0dex-thread", offset: 0, providerTurn: "turn-done" });
          yield* j.append("thread-b", { turnId: "turn-b", body: { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } } });
          const user = { itemId: "user-item-1", status: ItemStatus.COMPLETED, content: { case: "userMessage" as const, value: { text: "Run sleep 2" } } };
          yield* j.append("thread-b", { turnId: "turn-b", body: { case: "itemCompleted", value: { item: user } } });
          const command = { itemId: "exec-cmd-1", status: ItemStatus.IN_PROGRESS, content: { case: "commandExecution" as const, value: { command: "sleep 2" } } };
          yield* j.append("thread-b", { turnId: "turn-b", body: { case: "itemStarted", value: { item: command } } });
        }),
      ),
    );
    await previous.dispose();
    const next = ManagedRuntime.make(Journal.layer(path));
    const restarted = new WorkerHost({ runtime: next, dataDir: join(dir, "data-restart-rollout"), clientVersion: "test" });
    expect(await restarted.recover()).toEqual({ turns: 1, tasks: 0, fromTranscript: 1 });
    const pending = (await next.runPromise(Journal.use((j) => j.pending(new Map())))).filter((e) => e.threadId === "thread-b");
    const recovered = pending.slice(3).map((e) => [e.body.case, e.body.case === "itemCompleted" ? `${e.body.value.item?.itemId}:${ItemStatus[e.body.value.item?.status ?? 0]}` : ""]);
    // Only what the gateway does not have: the user message is not repeated.
    expect(recovered).toEqual([
      ["itemCompleted", "msg_commentary:COMPLETED"],
      ["itemCompleted", "call_cell_1:COMPLETED"],
      ["itemCompleted", "exec-cmd-1:COMPLETED"],
      ["itemCompleted", "msg_final:COMPLETED"],
      ["turnFinished", ""],
    ]);
    expect(pending.at(-1)?.body).toMatchObject({ case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: "turn-done" } });
    await restarted.close();
    await next.dispose();
  });
});
