import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import {
  BackgroundTaskKind,
  InteractionKind,
  ItemStatus,
  Provider,
  ThreadEventSchema,
  TurnOutcome,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { applyAck, journalHello, openGatewayLink, resendPending } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const directory = tempDir("canopy-ingest-recovery-");

type JournalRuntime = ReturnType<typeof journalRuntime>;

const journalRuntime = (path: string) => ManagedRuntime.make(Journal.layer(path));

const query = <A extends object>(gw: TestGateway, text: string, params: readonly string[] = []) =>
  gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(text, params)));

async function fixture() {
  const logs: string[] = [];
  const gw = await startTestGateway({ log: (message) => logs.push(message), diagnostics: true });
  gw.worker.holdTurns = true;
  const project = (await gw.api.createProject({ name: "Recovery" })).project!;

  const workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo" }))
    .workspace!;

  async function running(title: string) {
    const thread = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        title,
        initialMessage: "Keep running",
        clientRequestId: Bun.randomUUIDv7(),
      })
    ).thread!;

    const turns = await eventually(
      () =>
        query<{ id: string; status: string }>(gw, "SELECT id,status FROM turns WHERE thread_id=$1::uuid", [thread.id]),
      (rows) => rows[0]?.status === "running",
    );

    expect(turns[0]?.status).toBe("running");

    return { threadId: thread.id, turnId: turns[0]!.id };
  }

  const target = await running("Archived output");
  const healthy = await running("Unrelated running turn");
  gw.worker.link.close();
  expect(
    await eventually(
      async () => gw.core.online.has(gw.workerId),
      (online) => !online,
    ),
  ).toBe(false);

  return { gw, logs, target, healthy };
}

async function session(
  gw: TestGateway,
  runtime: JournalRuntime,
  running: { threadId: string; turnId: string }[],
  acknowledge = true,
) {
  // Protocol 1 with only the old running_turns capability: no new worker feature is required by the gateway fix.
  const link = await openGatewayLink({
    baseUrl: gw.grpcUrl,
    credential: gw.workerCredential,
    hello: {
      workerId: gw.workerId,
      workerLinkProtocol: 1,
      minWorkerLinkProtocol: 1,
      capabilities: ["running_turns"],
      runningTurns: running,
      ...(await runtime.runPromise(journalHello())),
    },
  });

  let drains = 0;

  const reading = (async () => {
    for await (const message of link.messages) {
      if (message.payload.case === "eventAck" && acknowledge) await runtime.runPromise(applyAck(message.payload.value));

      if (message.payload.case === "command")
        link.send({ case: "commandResult", value: { commandId: message.payload.value.commandId, ok: true } });

      if (message.payload.case === "drain") drains++;
    }
  })();

  await runtime.runPromise(resendPending(link));

  return {
    link,
    drains: () => drains,
    close: async () => {
      link.close();
      await reading;
    },
  };
}

async function appendOutput(runtime: JournalRuntime, threadId: string, turnId: string, text: string) {
  return runtime.runPromise(
    Journal.use((journal) =>
      journal.append(threadId, {
        turnId,
        body: {
          case: "itemCompleted",
          value: {
            item: {
              itemId: Bun.randomUUIDv7(),
              status: ItemStatus.COMPLETED,
              content: { case: "agentMessage", value: { text } },
            },
          },
        },
      }),
    ),
  );
}

async function empty(runtime: JournalRuntime) {
  expect(
    (
      await eventually(
        () => runtime.runPromise(journalHello()),
        (hello) => hello.threads.length === 0,
      )
    ).threads,
  ).toEqual([]);
}

describe.skipIf(!dockerAvailable)("worker poison event recovery over gRPC", () => {
  test("old worker replays a task completion and native follow-up after archive without starting a turn or draining", async () => {
    const { gw, target, healthy } = await fixture();
    const runtime = journalRuntime(join(directory, "background.db"));
    let connected: Awaited<ReturnType<typeof session>> | undefined;

    const task = {
      itemId: "bg:app-server",
      status: ItemStatus.IN_PROGRESS,
      content: {
        case: "backgroundTask" as const,
        value: {
          taskId: "app-server",
          kind: BackgroundTaskKind.SHELL,
          command: "local-app-server",
          startedInTurnId: target.turnId,
        },
      },
    };

    try {
      // The task is stored while visible and outlives its original turn.
      const start = await runtime.runPromise(
        Journal.use((j) =>
          j.append(target.threadId, {
            body: { case: "itemStarted", value: { item: task } },
          }),
        ),
      );

      await runtime.runPromise(
        Journal.use((j) =>
          j.append(target.threadId, {
            turnId: target.turnId,
            body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } },
          }),
        ),
      );
      connected = await session(gw, runtime, [healthy]);
      await empty(runtime);
      expect(
        await query(
          gw,
          "SELECT 1 FROM thread_items WHERE thread_id=$1::uuid AND item_id='bg:app-server' AND status='in_progress'",
          [target.threadId],
        ),
      ).toHaveLength(1);
      await gw.api.setThreadArchived({ threadId: target.threadId, archived: true });
      await connected.close();
      connected = undefined;

      // An old worker has no lifecycle capability: its SDK still journals the completion and new turn.
      await runtime.runPromise(
        Journal.use((j) =>
          j.append(target.threadId, {
            body: { case: "itemCompleted", value: { item: { ...task, status: ItemStatus.COMPLETED } } },
          }),
        ),
      );
      const continuation = Bun.randomUUIDv7();
      await runtime.runPromise(
        Journal.use((j) =>
          j.append(target.threadId, {
            turnId: continuation,
            body: { case: "turnStarted", value: {} },
          }),
        ),
      );
      await appendOutput(runtime, target.threadId, continuation, "Background work finished");
      await runtime.runPromise(
        Journal.use((j) =>
          j.append(target.threadId, {
            turnId: continuation,
            body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } },
          }),
        ),
      );
      connected = await session(gw, runtime, [healthy]);
      await empty(runtime);
      await gw.core.backgroundTasks.tick();
      expect(
        await query(gw, "SELECT 1 FROM turns WHERE thread_id=$1::uuid AND id<>$2::uuid", [
          target.threadId,
          target.turnId,
        ]),
      ).toHaveLength(0);
      expect(
        await query(gw, "SELECT 1 FROM background_task_notes WHERE thread_id=$1::uuid AND status='cancelled'", [
          target.threadId,
        ]),
      ).toHaveLength(1);
      expect(
        await query(
          gw,
          "SELECT 1 FROM thread_items WHERE thread_id=$1::uuid AND item_id='bg:app-server' AND status='completed'",
          [target.threadId],
        ),
      ).toHaveLength(1);
      expect(
        await query(gw, "SELECT 1 FROM worker_event_quarantine WHERE thread_id=$1::uuid", [target.threadId]),
      ).toHaveLength(3);
      expect(
        await query(gw, "SELECT 1 FROM turns WHERE id=$1::uuid AND status='running'", [healthy.turnId]),
      ).toHaveLength(1);
      expect(connected.drains()).toBe(0);
      expect(gw.core.online.has(gw.workerId)).toBe(true);
      expect(await query(gw, "SELECT 1 FROM thread_events WHERE event_id=$1::uuid", [start.eventId])).toHaveLength(1);
      await gw.api.setThreadArchived({ threadId: target.threadId, archived: false });
      await gw.core.backgroundTasks.tick();
      expect(
        await query(gw, "SELECT 1 FROM turns WHERE thread_id=$1::uuid AND id<>$2::uuid", [
          target.threadId,
          target.turnId,
        ]),
      ).toHaveLength(0);
    } finally {
      await connected?.close();
      await runtime.dispose();
      await gw.close();
    }
  }, 30_000);

  test("successful turn events commit before following interaction requests", async () => {
    const { gw, target, healthy } = await fixture();
    const runtime = journalRuntime(join(directory, "ordered.db"));
    let connected: Awaited<ReturnType<typeof session>> | undefined;

    try {
      connected = await session(gw, runtime, [target, healthy]);
      const enrich = gw.core.connectors.enrich.bind(gw.core.connectors);
      gw.core.connectors.enrich = async (events) => {
        await Bun.sleep(100);
        await enrich(events);
      };

      const turnId = Bun.randomUUIDv7();
      const requestId = Bun.randomUUIDv7();

      const started = await runtime.runPromise(
        Journal.use((journal) => journal.append(target.threadId, { turnId, body: { case: "turnStarted", value: {} } })),
      );

      connected.link.send({ case: "threadEvent", value: started });
      connected.link.send({
        case: "interactionRequest",
        value: {
          threadId: target.threadId,
          turnId,
          requestId,
          kind: InteractionKind.PERMISSION,
          toolName: "shell",
          requestJson: "{}",
        },
      });

      const rows = await eventually(
        () => query<{ turn_id: string }>(gw, "SELECT turn_id FROM interaction_requests WHERE id=$1::uuid", [requestId]),
        (rows) => rows.length === 1,
      );

      expect(rows[0]?.turn_id).toBe(turnId);
      expect(connected.drains()).toBe(0);
      expect(gw.core.online.has(gw.workerId)).toBe(true);
      await empty(runtime);
    } finally {
      await connected?.close();
      await runtime.dispose();
      await gw.close();
    }
  }, 30_000);

  for (const action of ["archive", "delete"] as const) {
    test(`${action}: old journals resolve without drains, unrelated turns survive, and lost ACKs recover after restart`, async () => {
      const f = await fixture();
      let gw = f.gw;
      const path = join(directory, `${action}.db`);
      let runtime = journalRuntime(path);
      let connected: Awaited<ReturnType<typeof session>> | undefined;

      try {
        const poison = await runtime.runPromise(
          Journal.use((j) =>
            j.append(f.target.threadId, { turnId: Bun.randomUUIDv7(), body: { case: "turnStarted", value: {} } }),
          ),
        );

        const output = await appendOutput(runtime, f.target.threadId, f.target.turnId, "Late output");

        const tool = await runtime.runPromise(
          Journal.use((journal) =>
            journal.append(f.target.threadId, {
              turnId: f.target.turnId,
              body: {
                case: "itemCompleted",
                value: {
                  item: {
                    itemId: Bun.randomUUIDv7(),
                    status: ItemStatus.COMPLETED,
                    content: {
                      case: "toolCall",
                      value: { name: "read_file", inputJson: "{}", output: "Late tool output" },
                    },
                  },
                },
              },
            }),
          ),
        );

        const end = await runtime.runPromise(
          Journal.use((j) =>
            j.append(f.target.threadId, {
              turnId: f.target.turnId,
              body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } },
            }),
          ),
        );

        await runtime.dispose();
        runtime = journalRuntime(path);

        if (action === "archive") await gw.api.setThreadArchived({ threadId: f.target.threadId, archived: true });
        else await gw.api.deleteThread({ threadId: f.target.threadId });
        connected = await session(gw, runtime, [f.healthy], false);
        const hello = await runtime.runPromise(journalHello());

        const cursor = await eventually(
          () =>
            query<{ acked_seq: bigint }>(
              gw,
              "SELECT acked_seq FROM worker_journal_cursors WHERE journal_id=$1 AND thread_id=$2::uuid",
              [hello.journalId, f.target.threadId],
            ),
          (rows) => rows[0]?.acked_seq === end.journalSeq,
        );

        expect(cursor[0]?.acked_seq).toBe(end.journalSeq);
        const diagnostics = await gw.api.getComputerDiagnostics({});
        expect(
          diagnostics.gatewayMeasures.find((row) => row.metricId === (action === "archive" ? 43 : 42))?.events,
        ).toBe(action === "archive" ? 1n : 4n);

        const events = await query<{ event_id: string; kind: string }>(
          gw,
          "SELECT event_id,kind FROM thread_events WHERE event_id=ANY($1::uuid[]) ORDER BY seq",
          [`{${[poison, output, tool, end].map((event) => event.eventId).join(",")}}`],
        );

        if (action === "archive") {
          expect(events.map((event) => event.kind)).toEqual([
            "notice",
            "item_completed",
            "item_completed",
            "turn_finished",
          ]);

          const [record] = await query<{ payload: Uint8Array; reason: string }>(
            gw,
            "SELECT payload,reason FROM worker_event_quarantine WHERE event_id=$1::uuid",
            [poison.eventId],
          );

          expect(record?.reason).toBe("archived_thread");
          expect(fromBinary(ThreadEventSchema, record!.payload)).toEqual(poison);
          expect(await query(gw, "SELECT 1 FROM turns WHERE id=$1::uuid", [poison.turnId])).toEqual([]);
        } else {
          expect(events).toEqual([]);
          expect(
            await query(gw, "SELECT 1 FROM worker_event_quarantine WHERE thread_id=$1::uuid", [f.target.threadId]),
          ).toEqual([]);
        }

        // Exceeds the old 1 s ingest-drain timer and proves this connection still accepts healthy output.
        await Bun.sleep(1_200);
        const progress = await appendOutput(runtime, f.healthy.threadId, f.healthy.turnId, "Still running");
        connected.link.send({ case: "threadEvent", value: progress });
        expect(
          await eventually(
            () => query(gw, "SELECT 1 FROM thread_events WHERE event_id=$1::uuid", [progress.eventId]),
            (rows) => rows.length === 1,
          ),
        ).toHaveLength(1);
        expect(connected.drains()).toBe(0);
        expect(gw.core.online.has(gw.workerId)).toBe(true);
        expect(
          await query(gw, "SELECT 1 FROM turns WHERE id=$1::uuid AND status='running'", [f.healthy.turnId]),
        ).toHaveLength(1);

        await connected.close();
        connected = undefined;

        const storage = {
          pg: gw.pg,
          secretsKey: gw.secretsKey,
          workerId: gw.workerId,
          workerCredential: gw.workerCredential,
        };

        await gw.close(true);
        await runtime.dispose();
        runtime = journalRuntime(path);
        gw = await startTestGateway({ storage });
        gw.worker.link.close();
        await eventually(
          async () => gw.core.online.has(gw.workerId),
          (online) => !online,
        );
        connected = await session(gw, runtime, [f.healthy]);
        await empty(runtime);
        expect(connected.link.welcome.persisted.find((row) => row.threadId === f.target.threadId)?.lastSeq).toBe(
          end.journalSeq,
        );
        expect(
          await query(
            gw,
            `SELECT 1 FROM threads WHERE id=$1::uuid AND ${action === "archive" ? "archived_at IS NOT NULL AND deleted_at IS NULL" : "deleted_at IS NOT NULL"}`,
            [f.target.threadId],
          ),
        ).toHaveLength(1);
        expect(connected.drains()).toBe(0);
      } finally {
        await connected?.close();
        await runtime.dispose();
        await gw.close();
      }
    }, 60_000);
  }

  test("bounded transient retries quarantine the original and preserve per-thread order while another turn advances", async () => {
    const f = await fixture();
    const { gw } = f;
    const runtime = journalRuntime(join(directory, "transient.db"));
    let connected: Awaited<ReturnType<typeof session>> | undefined;

    try {
      await query(
        gw,
        `CREATE FUNCTION reject_retry_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.payload->'notice'->>'code' = 'retry_test' THEN
          RAISE EXCEPTION 'serialization failure' USING ERRCODE='40001';
        END IF;
        RETURN NEW;
      END $$`,
      );
      await query(
        gw,
        "CREATE TRIGGER reject_retry_event BEFORE INSERT ON thread_events FOR EACH ROW EXECUTE FUNCTION reject_retry_event()",
      );

      const poison = await runtime.runPromise(
        Journal.use((j) =>
          j.append(f.target.threadId, {
            turnId: f.target.turnId,
            body: { case: "notice", value: { code: "retry_test", message: "Original output" } },
          }),
        ),
      );

      const later = await appendOutput(runtime, f.target.threadId, f.target.turnId, "Ordered later output");
      const healthy = await appendOutput(runtime, f.healthy.threadId, f.healthy.turnId, "Independent progress");
      connected = await session(gw, runtime, [f.target, f.healthy]);
      expect(
        await eventually(
          () => query(gw, "SELECT 1 FROM thread_events WHERE event_id=$1::uuid", [healthy.eventId]),
          (rows) => rows.length === 1,
        ),
      ).toHaveLength(1);
      expect(await query(gw, "SELECT 1 FROM thread_events WHERE event_id=$1::uuid", [later.eventId])).toHaveLength(0);
      expect((await runtime.runPromise(journalHello())).threads.some((row) => row.threadId === f.target.threadId)).toBe(
        true,
      );

      const quarantined = await eventually(
        () =>
          query<{ payload: Uint8Array; reason: string }>(
            gw,
            "SELECT payload,reason FROM worker_event_quarantine WHERE event_id=$1::uuid",
            [poison.eventId],
          ),
        (rows) => rows.length === 1,
        10_000,
      );

      expect(quarantined[0]?.reason).toBe("retry_exhausted");
      expect(fromBinary(ThreadEventSchema, quarantined[0]!.payload)).toEqual(poison);
      await empty(runtime);

      const rows = await query<{ event_id: string }>(
        gw,
        "SELECT event_id FROM thread_events WHERE event_id=ANY($1::uuid[]) ORDER BY seq",
        [`{${poison.eventId},${later.eventId}}`],
      );

      expect(rows.map((row) => row.event_id)).toEqual([poison.eventId, later.eventId]);
      expect(connected.drains()).toBe(0);
      expect(
        await query(gw, "SELECT 1 FROM turns WHERE id=$1::uuid AND status='running'", [f.healthy.turnId]),
      ).toHaveLength(1);
    } finally {
      await connected?.close();
      await runtime.dispose();
      await gw.close();
    }
  }, 30_000);
});
