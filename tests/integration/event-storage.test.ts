import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { create, fromBinary, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { ItemStatus, Provider, ThreadEventSchema, TurnOutcome } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore, Ingest } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { applyAck, journalHello, openGatewayLink, resendPending } from "@canopy/worker/gateway-link";
import { Journal, type ThreadEventInit } from "@canopy/worker/journal";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let threadId = "";
const dir = tempDir("canopy-event-storage-");

const query = <A extends object>(statement: string, params: readonly string[] = []) =>
  gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(statement, params)));

const output = (text: string): MessageInitShape<typeof ThreadEventSchema> => ({
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
});

async function replay(events: ThreadEventInit[], subject = threadId) {
  const path = join(dir, `${Bun.randomUUIDv7()}.db`);
  let runtime = ManagedRuntime.make(Journal.layer(path));

  const originals = await runtime.runPromise(
    Journal.use((journal) => Effect.all(events.map((e) => journal.append(subject, e)))),
  );

  // A journal created by an old worker is replayed after restart, without rewriting its contents.
  await runtime.dispose();
  runtime = ManagedRuntime.make(Journal.layer(path));
  const hello = await runtime.runPromise(journalHello());

  const link = await openGatewayLink({
    baseUrl: gw.grpcUrl,
    credential: gw.workerCredential,
    hello: { workerId: gw.workerId, ...hello },
  });

  let drains = 0;
  let closed = false;

  const reading = (async () => {
    for await (const message of link.messages) {
      if (message.payload.case === "eventAck") await runtime.runPromise(applyAck(message.payload.value));

      if (message.payload.case === "drain") drains++;
    }

    closed = true;
  })();

  await runtime.runPromise(resendPending(link));

  return {
    originals,
    runtime,
    link,
    drains: () => drains,
    closed: () => closed,
    empty: async () =>
      expect(
        await eventually(
          () => runtime.runPromise(journalHello()),
          (h) => h.threads.length === 0,
        ),
      ).toMatchObject({ threads: [] }),
    close: async () => {
      link.close();
      await reading;
      await runtime.dispose();
    },
  };
}

describe.skipIf(!dockerAvailable)("worker event storage on PostgreSQL and gRPC", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    const project = (await gw.api.createProject({ name: "Event storage" })).project!;

    const workspace = (
      await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo" })
    ).workspace!;

    threadId = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        title: "Output",
        clientRequestId: Bun.randomUUIDv7(),
      })
    ).thread!.id;
    await eventually(
      () => gw.api.getThread({ threadId }),
      (r) => r.thread?.status === "idle",
    );
    gw.worker.link.close();
    await eventually(
      async () => gw.core.online.has(gw.workerId),
      (online) => !online,
    );
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("a restarted journal with NUL in raw JSON, item ids, tool I/O and text drains and accepts later output", async () => {
    const raw = { "key\0": ["value\0", "\ud800", "\udc00", "😀", "literal \\u0000"] };

    const previous = (
      await query<{ provider_thread_id: string }>("SELECT provider_thread_id FROM threads WHERE id=$1::uuid", [
        threadId,
      ])
    )[0]!.provider_thread_id;

    const session = await replay([
      {
        rawJson: JSON.stringify(raw),
        body: { case: "threadReady", value: { providerThreadId: "provider\0id", replacesProviderThreadId: previous } },
      },
      {
        rawJson: JSON.stringify(raw),
        body: {
          case: "itemCompleted",
          value: {
            item: {
              itemId: "tool\0id",
              parentItemId: "parent\0id",
              status: ItemStatus.COMPLETED,
              content: {
                case: "toolCall",
                value: { name: "tool\0name", inputJson: "input\0json", output: "out\0put" },
              },
            },
          },
        },
      },
      output("message\0text 😀"),
    ]);

    try {
      await session.empty();

      const rows = await query<{ payload: JsonValue; raw: JsonValue }>(
        "SELECT payload,raw FROM thread_events WHERE event_id=$1::uuid",
        [session.originals[1]!.eventId],
      );

      expect(rows[0]!.raw).toEqual({ "key�": ["value�", "�", "�", "😀", "literal \\u0000"] });
      expect(rows[0]!.payload).toMatchObject({
        itemCompleted: {
          item: {
            itemId: "tool�id",
            parentItemId: "parent�id",
            toolCall: { name: "tool�name", inputJson: "input�json", output: "out�put" },
          },
        },
      });

      const projection = await query<{ item_id: string; parent_item_id: string; content: JsonValue }>(
        "SELECT item_id,parent_item_id,content FROM thread_items WHERE thread_id=$1::uuid AND item_id='tool�id'",
        [threadId],
      );

      expect(projection[0]).toMatchObject({
        item_id: "tool�id",
        parent_item_id: "parent�id",
        content: { toolCall: { output: "out�put" } },
      });
      expect(
        (
          await query<{ provider_thread_id: string }>("SELECT provider_thread_id FROM threads WHERE id=$1::uuid", [
            threadId,
          ])
        )[0]!.provider_thread_id,
      ).toBe("provider�id");

      const later = await session.runtime.runPromise(Journal.use((j) => j.append(threadId, output("later output"))));
      session.link.send({ case: "threadEvent", value: later });
      await session.empty();
      expect(await query("SELECT 1 FROM thread_events WHERE event_id=$1::uuid", [later.eventId])).toHaveLength(1);
      expect(session.drains()).toBe(0);
      expect(session.closed()).toBe(false);
      expect(await query("SELECT 1 FROM worker_event_quarantine WHERE thread_id=$1::uuid", [threadId])).toHaveLength(0);
    } finally {
      await session.close();
    }
  }, 20_000);

  test("a class-22 error quarantines only its event, commits a visible notice and remains deduplicated", async () => {
    const session = await replay([
      output("before invalid JSON"),
      { ...output("unsaved output"), rawJson: "{" },
      output("after invalid JSON"),
    ]);

    try {
      await session.empty();
      const bad = session.originals[1]!;

      const [quarantined] = await query<{ sqlstate: string; payload: Uint8Array }>(
        "SELECT sqlstate,payload FROM worker_event_quarantine WHERE event_id=$1::uuid",
        [bad.eventId],
      );

      expect(quarantined!.sqlstate).toBe("22P02");
      expect(fromBinary(ThreadEventSchema, quarantined!.payload)).toEqual(bad);

      const [marker] = await query<{ payload: JsonValue }>(
        "SELECT payload FROM thread_events WHERE event_id=$1::uuid",
        [bad.eventId],
      );

      expect(marker!.payload).toMatchObject({
        notice: {
          code: "event_quarantined",
          message: "Some output could not be saved. Later output will still appear.",
        },
      });
      expect(
        await query("SELECT 1 FROM thread_events WHERE event_id=$1::uuid", [session.originals[2]!.eventId]),
      ).toHaveLength(1);

      // Replay after a lost ACK uses the same identity; neither marker nor quarantine duplicates.
      session.link.send({ case: "threadEvent", value: bad });
      const result = await gw.runtime.runPromise(Ingest.use((i) => i.ingest(gw.workerId, "duplicate-replay", [bad])));
      expect(result.failedThreads).toEqual([]);
      expect(result.stored).toEqual([]);
      expect(result.acks.get(threadId)).toBe(bad.journalSeq);
      expect(await query("SELECT 1 FROM worker_event_quarantine WHERE event_id=$1::uuid", [bad.eventId])).toHaveLength(
        1,
      );
      expect(session.drains()).toBe(0);
    } finally {
      await session.close();
    }
  }, 20_000);

  test("a serialization failure keeps the journal unacked and succeeds through ordinary redelivery", async () => {
    await query(`CREATE FUNCTION reject_transient_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.payload->'notice'->>'code' = 'transient_test' THEN
        RAISE EXCEPTION 'temporary serialization failure' USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END $$`);
    await query(
      "CREATE TRIGGER reject_transient_event BEFORE INSERT ON thread_events FOR EACH ROW EXECUTE FUNCTION reject_transient_event()",
    );

    const session = await replay([
      { body: { case: "notice", value: { code: "transient_test", message: "transient" } } },
      output("after transient"),
    ]);

    try {
      expect(
        await eventually(
          async () => session.closed(),
          (closed) => closed,
        ),
      ).toBe(true);
      expect(session.drains()).toBe(1);
      expect((await session.runtime.runPromise(journalHello())).threads).toHaveLength(1);
      expect(
        await query("SELECT 1 FROM worker_event_quarantine WHERE event_id=$1::uuid", [session.originals[0]!.eventId]),
      ).toHaveLength(0);
      await query("DROP TRIGGER reject_transient_event ON thread_events");
      await query("DROP FUNCTION reject_transient_event()");
      const hello = await session.runtime.runPromise(journalHello());

      const link = await openGatewayLink({
        baseUrl: gw.grpcUrl,
        credential: gw.workerCredential,
        hello: { workerId: gw.workerId, ...hello },
      });

      const reading = (async () => {
        for await (const message of link.messages)
          if (message.payload.case === "eventAck") await session.runtime.runPromise(applyAck(message.payload.value));
      })();

      try {
        await session.runtime.runPromise(resendPending(link));
        await session.empty();
        expect(
          await query("SELECT 1 FROM thread_events WHERE event_id=$1::uuid", [session.originals[1]!.eventId]),
        ).toHaveLength(1);
      } finally {
        link.close();
        await reading;
      }
    } finally {
      await session.close();
    }
  }, 20_000);

  test("direct ingestion also replaces lone surrogates before jsonb projections", async () => {
    const event = create(ThreadEventSchema, {
      ...output("a\ud800b\udc00c😀"),
      eventId: Bun.randomUUIDv7(),
      threadId,
      journalSeq: 1n,
    });

    const result = await gw.runtime.runPromise(Ingest.use((i) => i.ingest(gw.workerId, Bun.randomUUIDv7(), [event])));
    expect(result.failedThreads).toEqual([]);
    expect(result.stored[0]!.event.body).toMatchObject({
      case: "itemCompleted",
      value: { item: { content: { case: "agentMessage", value: { text: "a�b�c😀" } } } },
    });
  });

  test("generated titles and command results share the storage text policy", async () => {
    const command = await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.enqueueCommand({
          workerId: gw.workerId,
          ttlSeconds: 30,
          command: { kind: { case: "generateText", value: {} } },
        }),
      ),
    );

    await gw.runtime.runPromise(
      GatewayStore.use((s) => s.commandDone(command.commandId, true, { generatedText: "title\0\ud800😀" })),
    );

    const [result] = await query<{ result: JsonValue }>("SELECT result FROM worker_commands WHERE id=$1::uuid", [
      command.commandId,
    ]);

    expect(result!.result).toEqual({ generatedText: "title��😀" });

    const [thread] = await query<{ title_revision: string }>("SELECT title_revision FROM threads WHERE id=$1::uuid", [
      threadId,
    ]);

    expect(
      await gw.runtime.runPromise(
        GatewayStore.use((s) => s.finishTitle(threadId, BigInt(thread!.title_revision), "title\0\ud800😀")),
      ),
    ).toBe(true);
    expect((await gw.api.getThread({ threadId })).thread!.title).toBe("title��😀");
  });

  test("bot journal projections normalize NUL and quarantine data errors without losing later output", async () => {
    const bot = Bun.randomUUIDv7();
    const turn = Bun.randomUUIDv7();
    const command = Bun.randomUUIDv7();
    await query(
      "INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance) VALUES($1::uuid,$2::uuid,$1,'{}','codex','native')",
      [bot, gw.userId],
    );
    await query(
      "INSERT INTO bot_turns(id,bot_id,client_request_id,input,status) VALUES($1::uuid,$2::uuid,$1,'test','running')",
      [turn, bot],
    );
    await query(
      "INSERT INTO worker_commands(id,worker_id,kind,payload,expires_at) VALUES($1::uuid,$2::uuid,'runBotTurn',''::bytea,now()+interval '1 hour')",
      [command, gw.workerId],
    );
    await query(
      "INSERT INTO bot_harness_turns(turn_id,bot_id,worker_id,command_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
      [turn, bot, gw.workerId, command],
    );
    await query(`CREATE FUNCTION reject_bot_output() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF position('reject payload' in NEW.text) > 0 THEN
        RAISE EXCEPTION 'invalid output encoding' USING ERRCODE = '22021';
      END IF;
      RETURN NEW;
    END $$`);
    await query(
      "CREATE TRIGGER reject_bot_output BEFORE UPDATE ON bot_harness_turns FOR EACH ROW EXECUTE FUNCTION reject_bot_output()",
    );

    const session = await replay(
      [
        { ...output("bot\0output"), turnId: turn },
        { ...output("reject payload"), turnId: turn },
        { ...output("later bot output"), turnId: turn },
        {
          turnId: turn,
          body: {
            case: "turnFinished",
            value: { outcome: TurnOutcome.COMPLETED, reason: "done\0reason", providerTurnRef: "ref\0id" },
          },
        },
      ],
      bot,
    );

    try {
      await session.empty();

      const [stored] = await query<{ text: string; reason: string; outcome: number }>(
        "SELECT text,reason,outcome FROM bot_harness_turns WHERE turn_id=$1::uuid",
        [turn],
      );

      expect(stored!.text.split("\n").sort()).toEqual(
        ["bot�output", "Some output could not be saved. Later output will still appear.", "later bot output"].sort(),
      );
      expect(stored!.reason).toBe("done�reason");
      expect(stored!.outcome).toBe(TurnOutcome.COMPLETED);
      expect(
        await query("SELECT 1 FROM worker_event_quarantine WHERE event_id=$1::uuid AND sqlstate='22021'", [
          session.originals[1]!.eventId,
        ]),
      ).toHaveLength(1);
      expect(session.drains()).toBe(0);
      session.link.send({ case: "threadEvent", value: session.originals[1]! });
    } finally {
      await session.close();
      await query("DROP TRIGGER reject_bot_output ON bot_harness_turns");
      await query("DROP FUNCTION reject_bot_output()");
    }
  }, 20_000);

  test("failure to persist quarantine rolls back the marker, earlier events and the journal cursor", async () => {
    await query(`CREATE FUNCTION fail_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'temporary quarantine failure' USING ERRCODE = '40001';
    END $$`);
    await query(
      "CREATE TRIGGER fail_quarantine BEFORE INSERT ON worker_event_quarantine FOR EACH ROW EXECUTE FUNCTION fail_quarantine()",
    );

    const events = [
      output("before quarantine failure"),
      { ...output("invalid"), rawJson: "{" },
      output("after quarantine failure"),
    ].map((init, index) =>
      create(ThreadEventSchema, {
        ...init,
        threadId,
        eventId: Bun.randomUUIDv7(),
        journalSeq: BigInt(index + 1),
      }),
    );

    const journalId = Bun.randomUUIDv7();

    try {
      const result = await gw.runtime.runPromise(Ingest.use((i) => i.ingest(gw.workerId, journalId, events)));
      expect(result.failedThreads).toHaveLength(1);
      expect(result.acks.size).toBe(0);
      expect(result.stored).toEqual([]);
      expect(
        await query("SELECT 1 FROM thread_events WHERE event_id=ANY($1::uuid[])", [
          `{${events.map((e) => e.eventId).join(",")}}`,
        ]),
      ).toHaveLength(0);
      expect(await query("SELECT 1 FROM worker_journal_cursors WHERE journal_id=$1", [journalId])).toHaveLength(0);
      expect(
        await query("SELECT 1 FROM worker_event_quarantine WHERE event_id=$1::uuid", [events[1]!.eventId]),
      ).toHaveLength(0);
    } finally {
      await query("DROP TRIGGER fail_quarantine ON worker_event_quarantine");
      await query("DROP FUNCTION fail_quarantine()");
    }

    const recovered = await gw.runtime.runPromise(Ingest.use((i) => i.ingest(gw.workerId, journalId, events)));
    expect(recovered.failedThreads).toEqual([]);
    expect(recovered.acks.get(threadId)).toBe(3n);
    expect(recovered.stored).toHaveLength(3);
  });
});
