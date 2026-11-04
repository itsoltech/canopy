import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  ItemDeltaField,
  ItemStatus,
  ThreadEventSchema,
  TurnEndSource,
  TurnOrigin,
  TurnOutcome,
  type ThreadEvent,
} from "@canopy/contracts";
import { migrate } from "@canopy/db";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
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
      event(ids.thread, 2, ids.turn, {
        case: "turnStarted",
        value: { providerTurnRef: "ct-1", origin: TurnOrigin.COMMAND },
      }),
      event(ids.thread, 3, ids.turn, {
        case: "itemStarted",
        value: { item: { itemId: "m1", status: ItemStatus.IN_PROGRESS, content: { case: "agentMessage", value: {} } } },
      }),
      event(ids.thread, 4, ids.turn, {
        case: "itemDelta",
        value: { itemId: "m1", field: ItemDeltaField.TEXT, chunk: "Hel" },
      }),
      event(ids.thread, 5, ids.turn, {
        case: "itemDelta",
        value: { itemId: "m1", field: ItemDeltaField.TEXT, chunk: "lo" },
      }),
      event(ids.thread, 6, ids.turn, {
        case: "turnFinished",
        value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: "ct-1", usage: { inputTokens: 10n } },
      }),
      event(ids.thread, 7, ids.turn),
    ];

    const result = await runtime.runPromise(Ingest.use((i) => i.ingest(ids.worker, "journal-1", events)));
    expect(result.acks.get(ids.thread)).toBe(7n);
    expect(result.stored.map((s) => Number(s.seq))).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const [thread] = await query<{ provider_thread_id: string; status: string; last_seq: bigint }>(
      `SELECT provider_thread_id, status, last_seq FROM threads WHERE id = $1`,
      [ids.thread],
    );

    expect(thread).toEqual({ provider_thread_id: "codex-1", status: "idle", last_seq: 7n });

    const [turn] = await query<{
      status: string;
      provider_turn_ref: string;
      first_seq: bigint;
      last_seq: bigint;
      usage: { inputTokens: string };
    }>(`SELECT status, provider_turn_ref, first_seq, last_seq, usage FROM turns WHERE id = $1`, [ids.turn]);

    expect(turn).toMatchObject({
      status: "completed",
      provider_turn_ref: "ct-1",
      first_seq: 2n,
      last_seq: 6n,
      usage: { inputTokens: "10" },
    });

    const items = await query<{
      item_id: string;
      type: string;
      status: string;
      content: { agentMessage: { text: string } };
      first_seq: bigint;
      last_seq: bigint;
    }>(`SELECT item_id, type, status, content, first_seq, last_seq FROM thread_items WHERE thread_id = $1`, [
      ids.thread,
    ]);

    expect(items).toEqual([
      {
        item_id: "m1",
        type: "agent_message",
        status: "in_progress",
        content: expect.objectContaining({ agentMessage: { text: "Hello" } }),
        first_seq: 3n,
        last_seq: 5n,
      },
    ]);

    const kinds = await query<{ kind: string; raw: unknown }>(
      `SELECT kind, raw FROM thread_events WHERE thread_id = $1 ORDER BY seq`,
      [ids.thread],
    );

    expect(kinds.map((k) => k.kind)).toEqual([
      "thread_ready",
      "turn_started",
      "item_started",
      "item_delta",
      "item_delta",
      "turn_finished",
      "provider_raw",
    ]);
    expect(kinds.every((k) => k.raw !== null)).toBe(true);

    const [cursor] = await query<{ acked_seq: bigint }>(
      `SELECT acked_seq FROM worker_journal_cursors WHERE worker_id = $1 AND journal_id = 'journal-1'`,
      [ids.worker],
    );

    expect(cursor?.acked_seq).toBe(7n);
  });

  test("resent events are ignored but still acked; new ones continue the sequence", async () => {
    const ids = await seed();
    const first = [event(ids.thread, 1, "", { case: "threadReady", value: { providerThreadId: "codex-2" } })];
    await runtime.runPromise(Ingest.use((i) => i.ingest(ids.worker, "j", first)));

    const again = await runtime.runPromise(
      Ingest.use((i) =>
        i.ingest(ids.worker, "j", [...first, event(ids.thread, 2, "", { case: "notice", value: { message: "hi" } })]),
      ),
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
          event(ids.thread, 1, providerTurn, {
            case: "turnStarted",
            value: { providerTurnRef: "ct-9", origin: TurnOrigin.PROVIDER },
          }),
          event(ids.thread, 2, providerTurn, {
            case: "turnFinished",
            value: { outcome: TurnOutcome.FAILED, reason: "boom" },
          }),
        ]),
      ),
    );

    const [turn] = await query<{
      trigger: string;
      status: string;
      ordinal: number;
      error: string;
      error_source: string;
    }>(`SELECT trigger, status, ordinal, error, error_source FROM turns WHERE id = $1`, [providerTurn]);

    // A worker without sources: its errors are its harness's.
    expect(turn).toEqual({ trigger: "provider", status: "failed", ordinal: 2, error: "boom", error_source: "harness" });
    // A failed turn does not make the thread unusable.
    const [thread] = await query<{ status: string }>(`SELECT status FROM threads WHERE id = $1`, [ids.thread]);
    expect(thread?.status).toBe("idle");
  });

  test("turn ends carry their source, error code and reason; a late end with another outcome rewrites them", async () => {
    const ids = await seed();
    await runtime.runPromise(
      Ingest.use((i) =>
        i.ingest(ids.worker, "j", [
          event(ids.thread, 1, ids.turn, { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } }),
          event(ids.thread, 2, ids.turn, {
            case: "turnFinished",
            value: {
              outcome: TurnOutcome.INTERRUPTED,
              source: TurnEndSource.SYSTEM,
              reason: "worker restarted mid-turn",
            },
          }),
        ]),
      ),
    );

    const read = () =>
      query<{
        status: string;
        interrupt_source: string | null;
        interrupt_reason: string | null;
        error_source: string | null;
        error_code: string | null;
        error: string | null;
      }>(
        `SELECT status, interrupt_source, interrupt_reason, error_source, error_code, error FROM turns WHERE id = $1`,
        [ids.turn],
      );

    expect((await read())[0]).toEqual({
      status: "interrupted",
      interrupt_source: "system",
      interrupt_reason: "worker restarted mid-turn",
      error_source: null,
      error_code: null,
      error: null,
    });
    await runtime.runPromise(
      Ingest.use((i) =>
        i.ingest(ids.worker, "j", [
          event(ids.thread, 3, ids.turn, {
            case: "turnFinished",
            value: {
              outcome: TurnOutcome.FAILED,
              source: TurnEndSource.HARNESS,
              reason: "unexpected status 401",
              errorCode: "http_connection_failed:401",
            },
          }),
        ]),
      ),
    );
    expect((await read())[0]).toEqual({
      status: "failed",
      interrupt_source: null,
      interrupt_reason: null,
      error_source: "harness",
      error_code: "http_connection_failed:401",
      error: "unexpected status 401",
    });
  });

  test("settle: open items of a finished turn end as interrupted (gateway events with the reason), background work stays", async () => {
    const ids = await seed();

    const item = <C extends object>(itemId: string, content: C) => ({
      itemId,
      status: ItemStatus.IN_PROGRESS,
      ...content,
    });

    await runtime.runPromise(
      Ingest.use((i) =>
        i.ingest(ids.worker, "j", [
          event(ids.thread, 1, "", { case: "threadReady", value: { providerThreadId: "codex-s" } }),
          event(ids.thread, 2, ids.turn, { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } }),
          event(ids.thread, 3, ids.turn, {
            case: "itemStarted",
            value: { item: item("cmd", { content: { case: "commandExecution", value: { command: "sleep 40" } } }) },
          }),
          event(ids.thread, 4, ids.turn, {
            case: "itemDelta",
            value: { itemId: "cmd", field: ItemDeltaField.OUTPUT, chunk: "partial" },
          }),
          event(ids.thread, 5, ids.turn, {
            case: "itemStarted",
            value: { item: item("bgcmd", { content: { case: "commandExecution", value: { command: "server" } } }) },
          }),
          event(ids.thread, 6, ids.turn, {
            case: "itemStarted",
            value: {
              item: item("bg:bgcmd", {
                content: { case: "backgroundTask", value: { taskId: "77", sourceItemId: "bgcmd" } },
              }),
            },
          }),
          event(ids.thread, 7, ids.turn, {
            case: "turnFinished",
            value: { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.SYSTEM, reason: "worker restarted" },
          }),
        ]),
      ),
    );
    expect(await runtime.runPromise(Ingest.use((i) => i.unsettledThreads(0)))).toContain(ids.thread);

    const settled = await runtime.runPromise(
      Ingest.use((i) => i.settle(ids.thread, "the turn ended while the item was still open")),
    );

    expect(
      settled.stored.map((s) => [
        s.event.body.case,
        s.event.body.case === "itemCompleted" ? s.event.body.value.item?.itemId : "",
      ]),
    ).toEqual([["itemCompleted", "cmd"]]);

    const items = await query<{ item_id: string; status: string; output: string | null }>(
      `SELECT item_id, status, content->'commandExecution'->>'output' AS output FROM thread_items WHERE thread_id = $1 ORDER BY first_seq`,
      [ids.thread],
    );

    // The output shown so far stays; the backgrounded command and its task keep running.
    expect(items).toEqual([
      { item_id: "cmd", status: "interrupted", output: "partial" },
      { item_id: "bgcmd", status: "in_progress", output: null },
      { item_id: "bg:bgcmd", status: "in_progress", output: null },
    ]);

    const [audit] = await query<{ origin: string; raw: { reason?: string } }>(
      `SELECT origin, raw FROM thread_events WHERE thread_id = $1 AND origin = 'gateway'`,
      [ids.thread],
    );

    expect(audit).toEqual({
      origin: "gateway",
      raw: { settled_by: "gateway", reason: "the turn ended while the item was still open" } as never,
    });
    // Idempotent: nothing more to do.
    expect((await runtime.runPromise(Ingest.use((i) => i.settle(ids.thread, "again")))).stored).toEqual([]);
    expect(await runtime.runPromise(Ingest.use((i) => i.unsettledThreads(0)))).not.toContain(ids.thread);
  });

  test("settle: a thread that looks busy or broken without a running turn is idle again", async () => {
    const stuck = async (status: string, providerThread: string | null) => {
      const ids = await seed();
      await query(`UPDATE threads SET status = $2, provider_thread_id = $3 WHERE id = $1`, [
        ids.thread,
        status,
        providerThread,
      ]);

      return ids.thread;
    };

    const running = await stuck("running", "p1");
    const interrupted = await stuck("interrupted", "p2");
    const failedTurn = await stuck("failed", "p3");
    const neverCreated = await stuck("failed", null);
    const unsettled = await runtime.runPromise(Ingest.use((i) => i.unsettledThreads(0)));
    expect(unsettled).toEqual(expect.arrayContaining([running, interrupted, failedTurn]));
    expect(unsettled).not.toContain(neverCreated);
    // A thread that changed just now may be waiting for its turn_started.
    expect(
      (await runtime.runPromise(Ingest.use((i) => i.settle(running, "sweep", { staleSeconds: 60 })))).threadChanged,
    ).toBe(false);

    for (const thread of [running, interrupted, failedTurn, neverCreated])
      await runtime.runPromise(Ingest.use((i) => i.settle(thread, "sweep")));

    const statuses = await query<{ id: string; status: string }>(
      `SELECT id, status FROM threads WHERE id = ANY($1::uuid[])`,
      [[running, interrupted, failedTurn, neverCreated]],
    );

    expect(Object.fromEntries(statuses.map((r) => [r.id, r.status]))).toEqual({
      [running]: "idle",
      [interrupted]: "idle",
      [failedTurn]: "idle",
      [neverCreated]: "failed",
    });
  });

  test("events of an unknown thread are not acked (they stay in the worker journal)", async () => {
    const ids = await seed();
    const result = await runtime.runPromise(Ingest.use((i) => i.ingest(ids.worker, "j", [event(id(), 1, "")])));
    expect(result.acks.size).toBe(0);
    expect(result.unknownThreads).toHaveLength(1);
  });

  test("goal_state: the live Codex sequence (set, user pause, resume, user clear) lands on the user's goal", async () => {
    const ids = await seed();
    const goal = id();
    await query(
      `INSERT INTO goals (id, thread_id, objective, status, created_by, created_by_user_id, token_budget) VALUES ($1, $2, 'Count to 3', 'active', 'user', $3, 80000)`,
      [goal, ids.thread, ids.user],
    );

    const ingest = (seq: number, body: Body) =>
      runtime.runPromise(Ingest.use((i) => i.ingest(ids.worker, "j", [event(ids.thread, seq, "", body)])));

    const row = async () =>
      (
        await query<{ status: string; native_status: string; finished_at: Date | null }>(
          `SELECT status, native_status, finished_at FROM goals WHERE id = $1`,
          [goal],
        )
      )[0];

    await ingest(1, {
      case: "goalState",
      value: { nativeStatus: "active", objective: "Count to 3", tokenBudget: 80000n },
    });
    expect(await row()).toMatchObject({ status: "active", native_status: "active" });
    await query(`UPDATE goals SET status = 'paused' WHERE id = $1`, [goal]); // the user's pause (core)
    await ingest(2, {
      case: "goalState",
      value: { nativeStatus: "paused", objective: "Count to 3", tokenBudget: 80000n },
    });
    expect(await row()).toMatchObject({ status: "paused", native_status: "paused" });
    await query(`UPDATE goals SET status = 'active' WHERE id = $1`, [goal]);
    await ingest(3, {
      case: "goalState",
      value: { nativeStatus: "active", objective: "Count to 3", tokenBudget: 80000n },
    });
    expect(await row()).toMatchObject({ status: "active", native_status: "active" });
    await query(`UPDATE goals SET status = 'cancelled', finished_at = now() WHERE id = $1`, [goal]); // the user's clear
    await ingest(4, { case: "goalState", value: { cleared: true } });
    expect(await row()).toMatchObject({ status: "cancelled", native_status: "cleared" });
  });
});
