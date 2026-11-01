import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ItemDeltaField, ItemStatus, ThreadEventSchema, TurnOrigin, TurnOutcome, type ThreadEvent } from "@open-agents/contracts";
import { migrate } from "@open-agents/db";
import { dockerAvailable, startPostgres, type TestPostgres } from "@open-agents/db/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { Ingest } from "../src/store/index.ts";

let pg: TestPostgres;
let runtime: ManagedRuntime.ManagedRuntime<Ingest | SqlClient.SqlClient, unknown>;
const id = () => Bun.randomUUIDv7();

const query = <A extends object>(text: string, params: unknown[] = []) =>
  runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(text, params)));

/** User, worker, project, workspace and a main thread with one queued user turn. */
async function seed() {
  const ids = { user: id(), worker: id(), project: id(), workspace: id(), thread: id(), turn: id() };
  await query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'U', 'user')`, [ids.user, `${ids.user}@x`]);
  await query(`INSERT INTO workers (id, owner_user_id, name, credential_hash) VALUES ($1, $2, 'w', 'h')`, [ids.worker, ids.user]);
  await query(`INSERT INTO projects (id, owner_user_id, name, slug) VALUES ($1::uuid, $2, 'P', $1::text)`, [ids.project, ids.user]);
  await query(`INSERT INTO project_workspaces (id, project_id, worker_id, root_path) VALUES ($1, $2, $3, '/repo')`, [ids.workspace, ids.project, ids.worker]);
  await query(
    `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, worker_id, workspace_id, cwd)
     VALUES ($1, $2, $3, 'main', $1, 'worker', 'codex', $4, $5, '/repo')`,
    [ids.thread, ids.project, ids.user, ids.worker, ids.workspace],
  );
  await query(`INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, input) VALUES ($1, $2, 1, 'user', $3, '{"text":"hi"}')`, [
    ids.turn, ids.thread, ids.user,
  ]);
  return ids;
}

type Body = NonNullable<MessageInitShape<typeof ThreadEventSchema>["body"]>;
const event = (threadId: string, journalSeq: number, turnId: string, body?: Body): ThreadEvent =>
  create(ThreadEventSchema, { threadId, journalSeq: BigInt(journalSeq), eventId: id(), turnId, ...(body && { body }), rawJson: '{"method":"x"}' });

describe.skipIf(!dockerAvailable)("Ingest on PostgreSQL", () => {
  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(Ingest.layer.pipe(Layer.provideMerge(pg.layer)));
    await runtime.runPromise(migrate);
  }, 60_000);
  afterAll(async () => {
    await runtime?.dispose();
    pg?.stop();
  });

  test("a full turn: provider thread id, turn lifecycle, items projected, thread idle again, cursor stored", async () => {
    const ids = await seed();
    const events = [
      event(ids.thread, 1, "", { case: "threadReady", value: { providerThreadId: "codex-1" } }),
      event(ids.thread, 2, ids.turn, { case: "turnStarted", value: { providerTurnRef: "ct-1", origin: TurnOrigin.COMMAND } }),
      event(ids.thread, 3, ids.turn, { case: "itemStarted", value: { item: { itemId: "m1", status: ItemStatus.IN_PROGRESS, content: { case: "agentMessage", value: {} } } } }),
      event(ids.thread, 4, ids.turn, { case: "itemDelta", value: { itemId: "m1", field: ItemDeltaField.TEXT, chunk: "Hel" } }),
      event(ids.thread, 5, ids.turn, { case: "itemDelta", value: { itemId: "m1", field: ItemDeltaField.TEXT, chunk: "lo" } }),
      event(ids.thread, 6, ids.turn, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: "ct-1", usage: { inputTokens: 10n } } }),
      event(ids.thread, 7, ids.turn),
    ];
    const result = await runtime.runPromise(Ingest.use((i) => i.ingest(ids.worker, "journal-1", events)));
    expect(result.acks.get(ids.thread)).toBe(7n);
    expect(result.stored.map((s) => Number(s.seq))).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const [thread] = await query<{ provider_thread_id: string; status: string; last_seq: bigint }>(
      `SELECT provider_thread_id, status, last_seq FROM threads WHERE id = $1`, [ids.thread]);
    expect(thread).toEqual({ provider_thread_id: "codex-1", status: "idle", last_seq: 7n });
    const [turn] = await query<{ status: string; provider_turn_ref: string; first_seq: bigint; last_seq: bigint; usage: { inputTokens: string } }>(
      `SELECT status, provider_turn_ref, first_seq, last_seq, usage FROM turns WHERE id = $1`, [ids.turn]);
    expect(turn).toMatchObject({ status: "completed", provider_turn_ref: "ct-1", first_seq: 2n, last_seq: 6n, usage: { inputTokens: "10" } });
    const items = await query<{ item_id: string; type: string; status: string; content: { agentMessage: { text: string } }; first_seq: bigint; last_seq: bigint }>(
      `SELECT item_id, type, status, content, first_seq, last_seq FROM thread_items WHERE thread_id = $1`, [ids.thread]);
    expect(items).toEqual([
      { item_id: "m1", type: "agent_message", status: "in_progress", content: expect.objectContaining({ agentMessage: { text: "Hello" } }), first_seq: 3n, last_seq: 5n },
    ]);
    const kinds = await query<{ kind: string; raw: unknown }>(`SELECT kind, raw FROM thread_events WHERE thread_id = $1 ORDER BY seq`, [ids.thread]);
    expect(kinds.map((k) => k.kind)).toEqual(["thread_ready", "turn_started", "item_started", "item_delta", "item_delta", "turn_finished", "provider_raw"]);
    expect(kinds.every((k) => k.raw !== null)).toBe(true);
    const [cursor] = await query<{ acked_seq: bigint }>(`SELECT acked_seq FROM worker_journal_cursors WHERE worker_id = $1 AND journal_id = 'journal-1'`, [ids.worker]);
    expect(cursor?.acked_seq).toBe(7n);
  });

  test("resent events are ignored but still acked; new ones continue the sequence", async () => {
    const ids = await seed();
    const first = [event(ids.thread, 1, "", { case: "threadReady", value: { providerThreadId: "codex-2" } })];
    await runtime.runPromise(Ingest.use((i) => i.ingest(ids.worker, "j", first)));
    const again = await runtime.runPromise(
      Ingest.use((i) => i.ingest(ids.worker, "j", [...first, event(ids.thread, 2, "", { case: "notice", value: { message: "hi" } })])),
    );
    expect(again.acks.get(ids.thread)).toBe(2n);
    expect(again.stored.map((s) => Number(s.seq))).toEqual([2]);
  });

  test("provider-started turns (goal continuation) are created on turn_started", async () => {
    const ids = await seed();
    const providerTurn = id();
    await runtime.runPromise(
      Ingest.use((i) =>
        i.ingest(ids.worker, "j", [
          event(ids.thread, 1, providerTurn, { case: "turnStarted", value: { providerTurnRef: "ct-9", origin: TurnOrigin.PROVIDER } }),
          event(ids.thread, 2, providerTurn, { case: "turnFinished", value: { outcome: TurnOutcome.FAILED, reason: "boom" } }),
        ]),
      ),
    );
    const [turn] = await query<{ trigger: string; status: string; ordinal: number; error: string }>(
      `SELECT trigger, status, ordinal, error FROM turns WHERE id = $1`, [providerTurn]);
    expect(turn).toEqual({ trigger: "provider", status: "failed", ordinal: 2, error: "boom" });
    const [thread] = await query<{ status: string }>(`SELECT status FROM threads WHERE id = $1`, [ids.thread]);
    expect(thread?.status).toBe("failed");
  });

  test("events of an unknown thread are not acked (they stay in the worker journal)", async () => {
    const ids = await seed();
    const result = await runtime.runPromise(Ingest.use((i) => i.ingest(ids.worker, "j", [event(id(), 1, "")])));
    expect(result.acks.size).toBe(0);
    expect(result.unknownThreads).toHaveLength(1);
  });
});
