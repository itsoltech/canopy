import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { MentionKind, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { idleTransactions, lockedWrite, pauseChecks } from "./support/message-admission.ts";

/**
 * docs/threads.md, "Przyjęcie wiadomości": checks run before the thread lock; only dedupe, admission and its
 * receipt hold it. Delivery follows the commit through the outbox.
 */
const refusals = { archive: /archived/, delete: /not found/, rewind: /rewinding/ };

describe.skipIf(!dockerAvailable)("message admission outside the thread lock", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    gw = await startTestGateway({ worker: { hello: { capabilities: ["thread_rewind_v1"] } } });
    projectId = (await gw.api.createProject({ name: "Admission" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/admission" }))
      .workspace!.id;
  });

  afterAll(async () => {
    await gw?.close();
  });

  const thread = async () =>
    (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

  const query = <A extends object>(run: (sql: SqlClient.SqlClient) => Effect.Effect<readonly A[], unknown>) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        return yield* run(yield* SqlClient.SqlClient);
      }),
    );

  const turns = (threadId: string) =>
    query(
      (sql) => sql<{ id: string; ordinal: number; status: string; client_request_id: string | null }>`
      SELECT id,ordinal,status,client_request_id FROM turns WHERE thread_id=${threadId}::uuid ORDER BY ordinal`,
    );

  const startedTurns = (threadId: string) =>
    gw.worker.commands.filter((c) => c.case === "startTurn" && c.value.thread?.threadId === threadId).length;

  const attachment = async () =>
    (await gw.api.uploadAttachment({ name: "notes.txt", data: new TextEncoder().encode("notes") })).attachment!.id;

  test("slow checks hold neither the thread row nor a pooled connection", async () => {
    const threadId = await thread();
    const attachmentIds = [await attachment()];
    const paused = pauseChecks(gw.core);
    const clientRequestId = crypto.randomUUID();
    const send = gw.api.sendMessage({ threadId, text: "Paused in its checks", attachmentIds, clientRequestId });

    try {
      await paused.reached;
      await lockedWrite(gw.runtime, threadId);
      const renamed = await gw.api.updateThread({ threadId, title: "Renamed during the checks" }, { timeoutMs: 2000 });
      expect(renamed.thread?.title).toBe("Renamed during the checks");
      expect(await idleTransactions(gw.runtime)).toBe(0);
    } finally {
      paused.release();
    }

    const sent = await send;
    expect((await turns(threadId)).map((t) => t.id)).toEqual([sent.turn!.id]);
    await eventually(
      async () => startedTurns(threadId),
      (n) => n === 1,
    );
  });

  test.each(["archive", "delete", "rewind"] as const)(
    "a %s that commits during the checks refuses the message",
    async (change) => {
      const threadId = await thread();

      if (change === "rewind") {
        await gw.api.sendMessage({ threadId, text: "First", clientRequestId: crypto.randomUUID() });
        await eventually(
          () => turns(threadId),
          (rows) => rows[0]?.status === "completed",
        );
      }

      const attachmentIds = [await attachment()];
      const paused = pauseChecks(gw.core);
      const clientRequestId = crypto.randomUUID();
      const send = failure(gw.api.sendMessage({ threadId, text: "Raced", attachmentIds, clientRequestId }));
      const rewindReply = Promise.withResolvers<() => void>();
      let rewound: Promise<unknown> = Promise.resolve();

      try {
        await paused.reached;

        if (change === "archive") await gw.api.setThreadArchived({ threadId, archived: true });
        else if (change === "delete") await gw.api.deleteThread({ threadId });
        else {
          gw.worker.handlers.set("rewindThread", (_value, reply) =>
            rewindReply.resolve(() => reply(true, { rewind: { providerThreadId: crypto.randomUUID() } })),
          );
          const target = (await turns(threadId))[0]!;
          rewound = gw.api.rewindThread({ threadId, turnId: target.id, clientRequestId: crypto.randomUUID() });
          await rewindReply.promise;
        }
      } finally {
        paused.release();
      }

      expect(await send).toMatch(refusals[change]);

      if (change === "rewind") {
        (await rewindReply.promise)();
        await rewound;
        gw.worker.handlers.delete("rewindThread");
      }

      expect((await turns(threadId)).filter((t) => t.client_request_id === clientRequestId)).toEqual([]);
    },
  );

  test("concurrent sends admit one at a time: one turn starts, the others queue or steer it", async () => {
    gw.worker.holdTurns = true;
    const threadId = await thread();

    try {
      const queued = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          gw.api.sendMessage({ threadId, text: `Queued ${i}`, clientRequestId: crypto.randomUUID() }),
        ),
      );

      const rows = await turns(threadId);
      expect(rows.map((t) => t.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(queued.map((r) => r.turn!.id))).toEqual(new Set(rows.map((t) => t.id)));
      await eventually(
        () => turns(threadId),
        (current) => current[0]?.status === "running",
      );
      expect(startedTurns(threadId)).toBe(1);

      const steers = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          gw.api.sendMessage({
            threadId,
            text: `Steer ${i}`,
            clientRequestId: crypto.randomUUID(),
            delivery: ui.MessageDelivery.STEER,
          }),
        ),
      );

      expect(steers.map((r) => r.steer?.turnId)).toEqual(Array.from({ length: 3 }, () => rows[0]!.id));
      expect(await turns(threadId)).toHaveLength(6);
    } finally {
      gw.worker.holdTurns = false;
    }
  });

  test("a /goal retried concurrently sets one goal and replays it", async () => {
    const threadId = await thread();

    const request = create(ui.SendMessageRequestSchema, {
      threadId,
      text: "/goal Ship the one objective",
      mentions: [{ kind: MentionKind.COMMAND, name: "goal", source: "platform", start: 0, end: 5 }],
      clientRequestId: crypto.randomUUID(),
    });

    const results = await Promise.all(Array.from({ length: 4 }, () => gw.api.sendMessage(request)));
    expect(new Set(results.map((r) => r.goal?.id))).toEqual(new Set([results[0]!.goal!.id]));
    expect(await query((sql) => sql`SELECT id FROM goals WHERE thread_id=${threadId}::uuid`)).toHaveLength(1);
    expect(
      await query(
        (sql) => sql`SELECT response FROM thread_message_receipts WHERE thread_id=${threadId}::uuid
          AND client_request_id=${request.clientRequestId}`,
      ),
    ).toHaveLength(1);
  });

  test("an admission whose receipt fails leaves no turn or command, and a retry admits once", async () => {
    const threadId = await thread();
    const request = { threadId, text: "Receipt fails once", clientRequestId: crypto.randomUUID() };
    await query((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE FUNCTION reject_message_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'Synthetic receipt failure'; END; $$`;

        return yield* sql`CREATE TRIGGER reject_message_receipt BEFORE INSERT ON thread_message_receipts
          FOR EACH ROW EXECUTE FUNCTION reject_message_receipt()`;
      }),
    );

    try {
      expect(await failure(gw.api.sendMessage(request))).toBeTruthy();
    } finally {
      await query((sql) =>
        Effect.gen(function* () {
          yield* sql`DROP TRIGGER reject_message_receipt ON thread_message_receipts`;

          return yield* sql`DROP FUNCTION reject_message_receipt()`;
        }),
      );
    }

    expect(await turns(threadId)).toEqual([]);
    expect(
      await query((sql) => sql`SELECT id FROM worker_commands WHERE thread_id=${threadId}::uuid AND kind='startTurn'`),
    ).toEqual([]);

    const sent = await gw.api.sendMessage(request);
    expect((await gw.api.sendMessage(request)).turn?.id).toBe(sent.turn!.id);
    await eventually(
      () => turns(threadId),
      (rows) => rows[0]?.status === "completed",
    );
    expect(startedTurns(threadId)).toBe(1);
  });

  test("a gateway restart between admission and delivery delivers the turn once", async () => {
    const threadId = await thread();
    gw.worker.link.close();
    await eventually(
      async () => gw.core.online.has(gw.workerId),
      (online) => !online,
    );

    const request = { threadId, text: "Admitted while the worker is away", clientRequestId: crypto.randomUUID() };
    const admitted = await gw.api.sendMessage(request);
    const { pg, secretsKey, workerId, workerCredential } = gw;
    await gw.close(true);
    gw = await startTestGateway({ storage: { pg, secretsKey, workerId, workerCredential } });

    expect((await gw.api.sendMessage(request)).turn?.id).toBe(admitted.turn!.id);
    await eventually(
      () => turns(threadId),
      (rows) => rows[0]?.status === "completed",
    );
    expect(await turns(threadId)).toHaveLength(1);
    expect(startedTurns(threadId)).toBe(1);
  });
});
