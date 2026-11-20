import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import {
  ItemDeltaField,
  ItemStatus,
  ThreadEventSchema,
  TurnOrigin,
  TurnOutcome,
  type ThreadEvent,
} from "@canopy/contracts";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
import { Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { randomBytes } from "node:crypto";
import { GatewayStore, Ingest } from "../src/store/index.ts";
import { compactTranscript } from "../src/maintenance/transcript.ts";

let pg: TestPostgres;
let runtime: ManagedRuntime.ManagedRuntime<Ingest | GatewayStore | SqlClient.SqlClient, unknown>;
const id = () => Bun.randomUUIDv7();

const query = <A extends object>(text: string, params: unknown[] = []) =>
  runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(text, params)));

/** User, worker, project, workspace and a main thread with one queued user turn. */
async function seed() {
  const ids = { user: id(), worker: id(), project: id(), workspace: id(), thread: id(), turn: id() };
  await query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'U', 'user')`, [
    ids.user,
    `${ids.user}@x`,
  ]);
  await query(`INSERT INTO workers (id, owner_user_id, name, credential_hash) VALUES ($1, $2, 'w', 'h')`, [
    ids.worker,
    ids.user,
  ]);
  await query(`INSERT INTO projects (id, owner_user_id, name, slug) VALUES ($1::uuid, $2, 'P', $1::text)`, [
    ids.project,
    ids.user,
  ]);
  await query(`INSERT INTO project_workspaces (id, project_id, worker_id, root_path) VALUES ($1, $2, $3, '/repo')`, [
    ids.workspace,
    ids.project,
    ids.worker,
  ]);
  await query(
    `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, worker_id, workspace_id, cwd)
     VALUES ($1, $2, $3, 'main', $1, 'worker', 'codex', $4, $5, '/repo')`,
    [ids.thread, ids.project, ids.user, ids.worker, ids.workspace],
  );
  await query(
    `INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, input) VALUES ($1, $2, 1, 'user', $3, '{"text":"hi"}')`,
    [ids.turn, ids.thread, ids.user],
  );

  return ids;
}

type Body = NonNullable<MessageInitShape<typeof ThreadEventSchema>["body"]>;

const event = (threadId: string, journalSeq: number, turnId: string, body?: Body): ThreadEvent =>
  create(ThreadEventSchema, {
    threadId,
    journalSeq: BigInt(journalSeq),
    eventId: id(),
    turnId,
    ...(body && { body }),
    rawJson: '{"method":"x"}',
  });

describe.skipIf(!dockerAvailable)("transcript storage on PostgreSQL", () => {
  beforeAll(async () => {
    pg = await startPostgres({ migrated: true });
    runtime = ManagedRuntime.make(
      Layer.mergeAll(Ingest.layer, GatewayStore.layer(randomBytes(32))).pipe(Layer.provideMerge(pg.layer)),
    );
    await query(
      `CREATE TABLE projection_writes(thread_id uuid,item_id text,writes int,PRIMARY KEY(thread_id,item_id))`,
    );
    await query(`CREATE FUNCTION record_projection_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO projection_writes VALUES(NEW.thread_id,NEW.item_id,1)
      ON CONFLICT(thread_id,item_id) DO UPDATE SET writes=projection_writes.writes+1;
      RETURN NEW; END $$`);
    await query(`CREATE TRIGGER record_projection_write AFTER INSERT OR UPDATE ON thread_items
      FOR EACH ROW EXECUTE FUNCTION record_projection_write()`);
  }, 60_000);
  afterAll(async () => {
    await runtime?.dispose();
    await pg?.stop();
  });

  test("coalesced deltas preserve the last effective sequence after a completed item", async () => {
    const ids = await seed();
    await runtime.runPromise(
      Ingest.use((i) =>
        i.ingest(ids.worker, "delta-barrier", [
          event(ids.thread, 1, ids.turn, {
            case: "turnStarted",
            value: { providerTurnRef: "t", origin: TurnOrigin.COMMAND },
          }),
          event(ids.thread, 2, ids.turn, {
            case: "itemStarted",
            value: {
              item: {
                itemId: "message",
                status: ItemStatus.IN_PROGRESS,
                content: { case: "agentMessage", value: { text: "" } },
              },
            },
          }),
          event(ids.thread, 3, ids.turn, {
            case: "itemDelta",
            value: { itemId: "message", field: ItemDeltaField.TEXT, chunk: "hello" },
          }),
          event(ids.thread, 4, ids.turn, {
            case: "itemDelta",
            value: { itemId: "message", field: ItemDeltaField.TEXT, chunk: "" },
          }),
          event(ids.thread, 5, ids.turn, {
            case: "itemCompleted",
            value: {
              item: {
                itemId: "message",
                status: ItemStatus.COMPLETED,
                content: { case: "agentMessage", value: { text: "hello" } },
              },
            },
          }),
          event(ids.thread, 6, ids.turn, {
            case: "itemDelta",
            value: { itemId: "message", field: ItemDeltaField.TEXT, chunk: "late" },
          }),
        ]),
      ),
    );

    const [item] = await query<{ content: { agentMessage: { text: string } }; last_seq: bigint }>(
      `SELECT content,last_seq FROM thread_items WHERE thread_id=$1 AND item_id='message'`,
      [ids.thread],
    );

    expect(item).toMatchObject({ content: { agentMessage: { text: "hello" } }, last_seq: 5n });
    expect(
      (
        await query<{ writes: number }>(
          `SELECT writes FROM projection_writes WHERE thread_id=$1 AND item_id='message'`,
          [ids.thread],
        )
      )[0]?.writes,
    ).toBe(3);
  });

  test("lossless raw references reduce settled JSON bytes and survive a fork and fresh read", async () => {
    const ids = await seed();
    const text = "provider text retained in the canonical item payload ".repeat(30);

    const rawJson = `{"method":"item/completed","params":{"item":{"id":"answer","text":${JSON.stringify(text)},"providerMetadata":{"usage":17,"opaque":"keep","large":12345678901234567890,"decimal":1.10,"exponent":1E+2,"negativeZero":-0}}}}`;

    const rawEvent = {
      ...event(ids.thread, 3, ids.turn, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "answer",
            status: ItemStatus.COMPLETED,
            content: { case: "agentMessage" as const, value: { text } },
          },
        },
      }),
      rawJson,
    };

    await runtime.runPromise(
      Ingest.use((i) =>
        i.ingest(ids.worker, "raw-bytes", [
          event(ids.thread, 1, ids.turn, {
            case: "turnStarted",
            value: { providerTurnRef: "t", origin: TurnOrigin.COMMAND },
          }),
          event(ids.thread, 2, ids.turn, {
            case: "itemStarted",
            value: {
              item: {
                itemId: "answer",
                status: ItemStatus.IN_PROGRESS,
                content: { case: "agentMessage", value: { text: "" } },
              },
            },
          }),
          rawEvent,
          event(ids.thread, 4, ids.turn, {
            case: "turnFinished",
            value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: "t" },
          }),
          {
            ...event(ids.thread, 5, ""),
            rawJson: JSON.stringify({ provider: "unknown", image: "data:image/png;base64,x" }),
          },
        ]),
      ),
    );

    await query(
      `UPDATE thread_events SET raw=$2::jsonb,raw_payload_refs=NULL,recorded_at=now()-interval '2 hours' WHERE thread_id=$1 AND seq=3`,
      [ids.thread, rawJson],
    );
    await query(`UPDATE thread_events SET recorded_at=now()-interval '2 hours' WHERE thread_id=$1`, [ids.thread]);

    const [before] = await query<{ raw_bytes: bigint; digest: string }>(
      `SELECT pg_column_size(raw)::bigint AS raw_bytes,md5(raw::text) AS digest FROM thread_events WHERE thread_id=$1 AND seq=3`,
      [ids.thread],
    );

    await runtime.runPromise(SqlClient.SqlClient.use((sql) => compactTranscript(sql, ids.user)));

    const [after] = await query<{ raw_bytes: bigint; raw: JsonValue; payload: JsonValue; refs: JsonValue }>(
      `SELECT pg_column_size(raw)::bigint AS raw_bytes,
              raw,payload,raw_payload_refs AS refs FROM thread_events WHERE thread_id=$1 AND seq=3`,
      [ids.thread],
    );

    expect(after.raw_bytes).toBeLessThan(before.raw_bytes);

    const [reconstructed] = await query<{ value: JsonValue }>(
      `SELECT thread_event_raw(raw,payload,raw_payload_refs) AS value FROM thread_events WHERE thread_id=$1 AND seq=3`,
      [ids.thread],
    );

    expect(reconstructed.value).toMatchObject({ method: "item/completed" });

    const [rawCheck] = await query<{ digest: string }>(
      `SELECT md5(thread_event_raw(raw,payload,raw_payload_refs)::text) AS digest
       FROM (SELECT raw,payload,raw_payload_refs
             FROM thread_events WHERE thread_id=$1 AND seq=3) checked`,
      [ids.thread],
    );

    expect(rawCheck.digest).toBe(before.digest);
    expect(
      (await query<{ raw: JsonValue }>(`SELECT raw FROM thread_events WHERE thread_id=$1 AND seq=5`, [ids.thread]))[0]!
        .raw,
    ).toEqual(JSON.parse(JSON.stringify({ provider: "unknown", image: "data:image/png;base64,x" })));

    const fork = id();
    await query(
      `INSERT INTO threads(id,project_id,owner_user_id,kind,parent_thread_id,root_thread_id,depth,runtime,provider,worker_id,workspace_id,cwd,fork_source_thread_id,fork_after_turn_id,status)
       VALUES($1,$2,$3,'side',$4,$4,1,'worker','codex',$5,$6,'/repo',$4,$7,'idle')`,
      [fork, ids.project, ids.user, ids.thread, ids.worker, ids.workspace, ids.turn],
    );

    const visible = await query<{ kind: string; payload: JsonValue }>(`SELECT kind,payload FROM thread_timeline($1)`, [
      fork,
    ]);

    expect(visible.some((row) => row.kind === "item_completed")).toBe(true);

    const fresh = ManagedRuntime.make(
      Layer.mergeAll(Ingest.layer, GatewayStore.layer(randomBytes(32))).pipe(Layer.provideMerge(pg.layer)),
    );

    try {
      const snapshot = await fresh.runPromise(GatewayStore.use((store) => store.snapshot(ids.thread)));
      expect(snapshot.items.find((item) => item.item?.itemId === "answer")?.item?.content).toMatchObject({
        case: "agentMessage",
        value: { text },
      });
    } finally {
      await fresh.dispose();
    }
  });

  test("tool arguments and results use verified JSON references, including during historical compaction", async () => {
    const ids = await seed();

    const input = JSON.stringify({
      paths: Array.from({ length: 40 }, (_, i) => `apps/gateway/src/feature-${i}/index.ts`),
    });

    const makeResult = (scale: string) =>
      `[{"text":${JSON.stringify(input.repeat(2))}, "scale":${scale}, "number":12345678901234567890}]`;

    const result = makeResult("1.10");

    const file = {
      path: "apps/gateway/src/handler.ts",
      kind: "update",
      diff: Array.from({ length: 60 }, (_, i) => `+export const handler${i} = () => readHistory(${i});`).join("\n"),
    };

    const tool = (seq: number, rawResult: string, output = result): ThreadEvent => ({
      ...event(ids.thread, seq, ids.turn, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: `tool-${seq}`,
            status: ItemStatus.COMPLETED,
            content: { case: "toolCall", value: { inputJson: input, output } },
          },
        },
      }),
      rawJson: `{"method":"item/completed","params":{"item":{"arguments":${input},"result":{"content":${rawResult}}}}}`,
    });

    const exact = tool(2, result);
    const differentScale = tool(3, makeResult("1.1"));
    const imageContent = JSON.stringify([{ type: "image", mimeType: "image/png", data: "A".repeat(3200) }]);
    const image = tool(5, imageContent, imageContent);

    const patch = {
      ...event(ids.thread, 4, ids.turn, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "patch",
            status: ItemStatus.COMPLETED,
            content: { case: "fileChange", value: { changes: [file] } },
          },
        },
      }),
      rawJson: JSON.stringify({ method: "item/completed", params: { item: { changes: [file] } } }),
    };

    await runtime.runPromise(
      Ingest.use((i) =>
        i.ingest(ids.worker, "structured-raw", [
          event(ids.thread, 1, ids.turn, {
            case: "turnStarted",
            value: { providerTurnRef: "t", origin: TurnOrigin.COMMAND },
          }),
          exact,
          differentScale,
          patch,
          image,
          event(ids.thread, 6, ids.turn, {
            case: "turnFinished",
            value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: "t" },
          }),
        ]),
      ),
    );

    const stored = (seq: number, raw: string) =>
      query<{ exact: boolean; refs: number | null }>(
        `SELECT thread_event_raw(raw,payload,raw_payload_refs)::text=($3::jsonb)::text AS exact,
              jsonb_array_length(raw_payload_refs) AS refs FROM thread_events WHERE thread_id=$1 AND seq=$2`,
        [ids.thread, seq, raw],
      );

    expect(await stored(2, exact.rawJson)).toEqual([{ exact: true, refs: 2 }]);
    expect(await stored(3, differentScale.rawJson)).toEqual([{ exact: true, refs: 1 }]);
    expect(await stored(4, patch.rawJson)).toEqual([{ exact: true, refs: 1 }]);
    expect(await stored(5, image.rawJson)).toEqual([{ exact: true, refs: null }]);

    await query(`UPDATE thread_events SET raw=$2::jsonb,raw_payload_refs=NULL WHERE thread_id=$1 AND seq=2`, [
      ids.thread,
      exact.rawJson,
    ]);
    await query(`UPDATE thread_events SET recorded_at=now()-interval '2 hours' WHERE thread_id=$1`, [ids.thread]);
    await runtime.runPromise(SqlClient.SqlClient.use((sql) => compactTranscript(sql, ids.user)));

    expect(await stored(2, exact.rawJson)).toEqual([{ exact: true, refs: 2 }]);
  });
});
