import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  PermissionMode,
  Provider,
  ThreadEventSchema,
  TurnEndSource,
  TurnOrigin,
  TurnOutcome,
  ui,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { SHELL_INPUT_CAPABILITY, WORKER_OOM_CONTINUATION } from "@canopy/domain";
import { SERVICE_TIERS_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayStore, Ingest, SteerStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreIngest } from "../../apps/gateway/src/core/core-workers.ts";
import { eventually, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

const capabilities = ["running_turns", SHELL_INPUT_CAPABILITY, SERVICE_TIERS_CAPABILITY, "thread_rewind_v1"];
const cause = "the worker service stopped because of memory pressure";
const oom = { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.SYSTEM, reason: cause, workerOomRecovery: true };
let gw: TestGateway;
let worker: ScriptedWorker;
let projectId: string;
let workspaceId: string;

const turns = (threadId: string) =>
  gw.runtime.runPromise(
    SqlClient.SqlClient.use(
      (sql) =>
        sql<{
          id: string;
          status: string;
          trigger: string;
          goal_id: string | null;
          resumes_turn_id: string | null;
          interrupt_reason: string | null;
        }>`SELECT id, status, trigger, goal_id, resumes_turn_id, interrupt_reason FROM turns WHERE thread_id = ${threadId}::uuid ORDER BY ordinal`,
    ),
  );

async function running(
  text = "Review the pending changes",
  options: Partial<Pick<ui.SendMessageRequest, "model" | "effort" | "serviceTier" | "permissionMode">> = {},
) {
  const thread = (
    await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, permissionMode: PermissionMode.ASK })
  ).thread!;

  const threadId = thread.id;
  await eventually(
    () => gw.api.getThread({ threadId }),
    (r) => r.thread?.status === "idle",
  );
  const turn = (await gw.api.sendMessage({ threadId, text, ...options })).turn!;

  const started = await eventually(
    () => turns(threadId),
    (rows) => rows[0]?.status === "running",
  );

  expect(started[0]).toMatchObject({ id: turn.id, status: "running" });

  return { threadId, turnId: turn.id };
}

type Target = { threadId: string; turnId: string };

function finish(target: Target, value = oom, journalSeq = 3n) {
  return create(ThreadEventSchema, {
    ...target,
    journalSeq,
    eventId: Bun.randomUUIDv7(),
    body: { case: "turnFinished", value },
  });
}

/** Await the link's normal ingest callback, including its transaction and queue pump, before asserting absence. */
async function ingest(event: ReturnType<typeof finish>) {
  const connection = gw.core.link.connections.get(gw.workerId)!;
  expect(await coreIngest(gw.core, connection, [event])).toBeUndefined();

  // A quarantined event is acknowledged too, but would make every negative case pass spuriously.
  const recorded = await gw.runtime.runPromise(
    SqlClient.SqlClient.use(
      (sql) =>
        sql`SELECT 1 FROM thread_events WHERE thread_id = ${event.threadId}::uuid AND event_id = ${event.eventId}::uuid AND origin = 'worker' AND kind = 'turn_finished'`,
    ),
  );

  expect(recorded).toHaveLength(1);
}

async function completeHeld(threadId: string, turnId: string) {
  worker.finish(threadId, turnId);
  const status = async () => (await turns(threadId)).find((row) => row.id === turnId)?.status;
  expect(await eventually(status, (current) => current === "completed")).toBe("completed");
}

async function restartWhileRunning(threadId: string) {
  // Hello can settle the missing turn before its journal reaches the gateway.
  worker.link.close();
  expect(
    await eventually(
      async () => gw.core.online.has(gw.workerId),
      (online) => !online,
    ),
  ).toBe(false);
  worker = await gw.connect(gw.workerId, gw.workerCredential, undefined, {
    hello: { capabilities, runningTurns: [] },
  });
  worker.holdTurns = true;
  expect(
    (
      await eventually(
        () => turns(threadId),
        (rows) => rows[0]?.status === "interrupted",
      )
    )[0]?.interrupt_reason,
  ).toBe("worker restarted");
}

async function toggleThreads(enabled: boolean) {
  const { user } = await gw.api.getSettings({});
  await gw.api.updateUserSettings({
    expectedVersion: user!.version,
    modules: { enabled: enabled ? ["threads", "bots"] : ["bots"] },
  });
}

describe.skipIf(!dockerAvailable)("worker OOM continuation over the gateway queue", () => {
  beforeAll(async () => {
    gw = await startTestGateway({ worker: { hello: { capabilities } } });
    worker = gw.worker;
    worker.holdTurns = true;
    projectId = (await gw.api.createProject({ name: "OOM continuation" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60_000);
  afterAll(async () => gw?.close());

  test("a journal report after reconnect starts one distinct turn in the same provider session with the original choices", async () => {
    const original = await running("Review the pending changes", {
      model: "gpt-5.5",
      effort: "high",
      serviceTier: "default",
    });

    const { threadId, turnId } = original;

    const session = (await gw.runtime.runPromise(GatewayStore.use((store) => store.thread(threadId))))
      .provider_thread_id;

    expect(session).toBeTruthy();

    await restartWhileRunning(threadId);

    const report = finish(original);
    worker.link.send({ case: "threadEvent", value: report });

    const rows = await eventually(
      () => turns(threadId),
      (current) => current[1]?.status === "running",
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: turnId, status: "interrupted", interrupt_reason: cause });
    const resumed = rows[1]!;
    expect(resumed).toMatchObject({ status: "running", trigger: "recovery", resumes_turn_id: turnId });
    expect(resumed.id).not.toBe(turnId);
    const start = worker.commands.find((k) => k.case === "startTurn" && k.value.turnId === resumed.id);
    expect(start?.value).toMatchObject({
      thread: { threadId, providerThreadId: session },
      model: "gpt-5.5",
      effort: "high",
      serviceTier: "default",
      permissionMode: PermissionMode.ASK,
      input: { text: WORKER_OOM_CONTINUATION, authorUserId: "", attachments: [], mentions: [] },
    });

    await ingest(report);
    await ingest(finish({ threadId, turnId: resumed.id }, oom, 5n));
    await ingest(finish(original, oom, 6n));
    expect((await turns(threadId)).map((row) => [row.id, row.status])).toEqual([
      [turnId, "interrupted"],
      [resumed.id, "interrupted"],
    ]);
  }, 20_000);

  test("a newer queued user message takes precedence over recovery", async () => {
    const original = await running();
    const { threadId } = original;
    const newer = (await gw.api.sendMessage({ threadId, text: "Work on this instead" })).turn!;
    expect(newer.dispatched).toBe(false);
    await ingest(finish(original));

    const rows = await eventually(
      () => turns(threadId),
      (current) => current[1]?.status === "running",
    );

    expect(rows.map((row) => [row.id, row.status])).toEqual([
      [original.turnId, "interrupted"],
      [newer.id, "running"],
    ]);
    await completeHeld(threadId, newer.id);
  });

  test("an accepted steer that never joined the original turn runs next as the sole fallback", async () => {
    const original = await running();
    const { threadId } = original;
    worker.handlers.set("steerTurn", (_command, reply) => reply(true));

    try {
      const steer = (
        await gw.api.sendMessage({ threadId, text: "Use the newer instructions", delivery: ui.MessageDelivery.STEER })
      ).steer!;

      const receipt = () => gw.runtime.runPromise(SteerStore.use((store) => store.steer(steer.id)));
      expect((await eventually(receipt, (row) => row.status === "accepted")).status).toBe("accepted");
      await ingest(finish(original));
      const fallback = await receipt();

      const rows = await eventually(
        () => turns(threadId),
        (current) => current[1]?.status === "running",
      );

      expect(rows.map((row) => row.trigger)).toEqual(["user", "user"]);
      expect(fallback).toMatchObject({ status: "queued", queued_turn_id: rows[1]!.id });
      expect(worker.inputs.get(threadId)).toEqual(["Review the pending changes", "Use the newer instructions"]);
      await completeHeld(threadId, rows[1]!.id);
    } finally {
      worker.handlers.delete("steerTurn");
    }
  });

  test("a delivered agent steer keeps its call attached to the interrupted user turn", async () => {
    const sender = await running();
    const target = await running();
    const callId = Bun.randomUUIDv7();

    const sent = await worker.callTool({
      ...sender,
      callId,
      tool: "send_message",
      args: { thread_id: target.threadId, prompt: "Include my changes", delivery: "steer", notify: false },
    });

    expect(sent.isError).toBe(false);

    const targetTurn = () =>
      gw.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) =>
            sql<{
              target_turn_id: string | null;
            }>`SELECT target_turn_id FROM agent_bus_calls WHERE id = ${callId}::uuid`,
        ),
      );

    expect((await eventually(targetTurn, (rows) => rows[0]?.target_turn_id === target.turnId))[0]?.target_turn_id).toBe(
      target.turnId,
    );
    await ingest(finish(target));
    expect((await turns(target.threadId)).map((row) => row.id)).toEqual([target.turnId]);
    expect((await targetTurn())[0]?.target_turn_id).toBe(target.turnId);
    await completeHeld(sender.threadId, sender.turnId);
  });

  test.each(["active", "pause", "clear"] as const)(
    "honors goal state (%s) when a user turn reports OOM",
    async (action) => {
      const original = await running();
      const { threadId, turnId } = original;
      worker.emit(threadId, turnId, {
        case: "goalState",
        value: { nativeStatus: "active", objective: "Review the pending changes" },
      });

      const [source] = await eventually(
        () => turns(threadId),
        (rows) => Boolean(rows[0]?.goal_id),
      );

      expect(source?.goal_id).toBeTruthy();

      if (action !== "active") await gw.api.setGoal({ threadId, action });
      await ingest(finish(original, oom, 4n));

      if (action !== "active") {
        expect((await turns(threadId)).map((row) => row.id)).toEqual([turnId]);

        return;
      }

      const rows = await eventually(
        () => turns(threadId),
        (current) => current[1]?.status === "running",
      );

      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ trigger: "recovery", resumes_turn_id: turnId, goal_id: source!.goal_id });
      await completeHeld(threadId, rows[1]!.id);

      // Native goal iterations have their own continuation lifecycle.
      const iteration = Bun.randomUUIDv7();
      worker.emit(threadId, iteration, {
        case: "turnStarted",
        value: { origin: TurnOrigin.PROVIDER, providerTurnRef: "goal-turn" },
      });
      expect(
        (
          await eventually(
            () => turns(threadId),
            (current) => current[2]?.id === iteration,
          )
        )[2],
      ).toMatchObject({ goal_id: source!.goal_id, trigger: "provider", status: "running" });
      await ingest(finish({ threadId, turnId: iteration }, oom, 9n));
      expect((await turns(threadId)).map((row) => row.id)).toEqual([turnId, rows[1]!.id, iteration]);
    },
  );

  test("manual Stop wins even if a late OOM report arrives before a worker interrupt event", async () => {
    const original = await running();
    await gw.api.interruptThread({ threadId: original.threadId });
    await ingest(finish(original));
    expect((await turns(original.threadId)).map((row) => row.id)).toEqual([original.turnId]);
  });

  test("Stop after Hello settles the lost turn still suppresses the delayed journal continuation", async () => {
    const original = await running();
    await restartWhileRunning(original.threadId);
    await gw.api.interruptThread({ threadId: original.threadId });
    await ingest(finish(original));
    expect((await turns(original.threadId)).map((row) => row.id)).toEqual([original.turnId]);
  });

  test.each([
    ["a worker without the flag", { ...oom, workerOomRecovery: false }],
    ["a completed turn", { ...oom, outcome: TurnOutcome.COMPLETED }],
    ["a failed turn", { ...oom, outcome: TurnOutcome.FAILED }],
    ["a user interruption", { ...oom, source: TurnEndSource.USER }],
  ] as const)("does not resume %s", async (_label, ending) => {
    const original = await running();
    await ingest(finish(original, ending));
    const terminal = await turns(original.threadId);
    expect(terminal.map((row) => row.id)).toEqual([original.turnId]);

    // Only the gateway's provisional restart outcome can be corrected by a later OOM report.
    await ingest(finish(original, oom, 4n));
    expect(await turns(original.threadId)).toEqual(terminal);
  });

  test("an explicit shell command is never retried", async () => {
    const original = await running("!pwd");
    expect(worker.started.get(original.turnId)?.shellCommand).toBe("pwd");
    await ingest(finish(original));
    expect((await turns(original.threadId)).map((row) => row.id)).toEqual([original.turnId]);
  });

  test.each([PermissionMode.READ_ONLY, PermissionMode.FULL_AUTO])(
    "a one-turn permission override (%i) cannot authorize a continuation",
    async (permissionMode) => {
      const original = await running("Review the changes", { permissionMode });
      expect(worker.turnModes.get(original.turnId)).toEqual({ thread: PermissionMode.ASK, turn: permissionMode });
      await ingest(finish(original));
      expect((await turns(original.threadId)).map((row) => row.id)).toEqual([original.turnId]);
    },
  );

  test("a permission change after durable admission cancels the queued recovery before dispatch", async () => {
    const original = await running();
    const { threadId } = original;
    // Hold the thread lock across both writes so even an already running pump sees the permission change.
    const report = finish(original);

    const admitted = await gw.runtime.runPromise(
      SqlClient.SqlClient.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const receipt = yield* Ingest.use((store) => store.ingest(gw.workerId, "oom-journal", [report]));
            const queue = yield* sql`SELECT status FROM turns WHERE resumes_turn_id = ${original.turnId}::uuid`;
            yield* GatewayStore.use((store) => store.updateThreadSettings(threadId, { permissionMode: "FULL_AUTO" }));

            return { receipt, queue };
          }),
        ),
      ),
    );

    expect(admitted.receipt.acks.get(threadId)).toBe(report.journalSeq);
    expect(admitted.queue).toEqual([{ status: "queued" }]);
    await gw.core.pump(threadId);
    expect((await turns(threadId))[1]?.status).toBe("cancelled");
    expect(worker.inputs.get(threadId)).toEqual(["Review the pending changes"]);
  });

  test("a pending rewind fences the original turn before its late OOM report arrives", async () => {
    const original = await running();
    const request = create(ui.ThreadRewindRequestSchema, { ...original, stopRunning: true, clientRequestId: "rewind" });
    // Persist the intent; the worker has not yet answered its outbox command.
    const pending = await gw.runtime.runPromise(GatewayStore.use((store) => store.beginRewind(gw.userId, request)));
    expect(pending.operation.status).toBe("pending");
    await ingest(finish(original));
    expect((await turns(original.threadId)).map((row) => row.id)).toEqual([original.turnId]);
  });

  test("archiving a thread fences a late OOM report", async () => {
    const original = await running();
    await gw.api.setThreadArchived({ threadId: original.threadId, archived: true });
    await ingest(finish(original));
    expect((await turns(original.threadId)).map((row) => row.id)).toEqual([original.turnId]);
  });

  test("disabling threads fences the interrupted turn even after re-enabling the module", async () => {
    const original = await running();
    await toggleThreads(false);

    try {
      await ingest(finish(original));
      expect((await turns(original.threadId)).map((row) => row.id)).toEqual([original.turnId]);
    } finally {
      await toggleThreads(true);
    }

    await ingest(finish(original, oom, 4n));
    expect((await turns(original.threadId)).map((row) => row.id)).toEqual([original.turnId]);
  });
});
