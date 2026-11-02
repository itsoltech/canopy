import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { migrate } from "../src/index.ts";
import { dockerAvailable, startPostgres, type TestPostgres } from "../src/testing.ts";

const id = () => Bun.randomUUIDv7();

let pg: TestPostgres;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;

/** Runs a query and returns its rows. */
function query<A extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<ReadonlyArray<A>> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<A>(text, params);
    }),
  );
}

/** Expects the statement to fail and returns the database error message. */
async function failure(text: string, params: unknown[] = []): Promise<string> {
  const error = await query(text, params).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (error === undefined) throw new Error(`expected failure: ${text}`);
  // SqlError -> reason -> driver error; collect every message plus the constraint name.
  const messages: string[] = [];
  for (let current: unknown = error; current instanceof Object; current = (current as { cause?: unknown }).cause) {
    const { message, constraint } = current as { message?: unknown; constraint?: unknown };
    if (typeof message === "string") messages.push(message);
    if (typeof constraint === "string") messages.push(constraint);
  }
  return messages.join(" | ");
}

// ------------------------------------------------------------------ fixtures

interface World {
  user: string;
  worker: string;
  otherWorker: string;
  project: string;
  workspace: string;
}

async function world(): Promise<World> {
  const w = { user: id(), worker: id(), otherWorker: id(), project: id(), workspace: id() };
  await query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'U', 'user')`, [w.user, `${w.user}@x`]);
  await query(`INSERT INTO workers (id, owner_user_id, name, credential_hash) VALUES ($1, $3, 'w1', 'h'), ($2, $3, 'w2', 'h')`, [
    w.worker, w.otherWorker, w.user,
  ]);
  await query(`INSERT INTO projects (id, owner_user_id, name, slug) VALUES ($1::uuid, $2, 'P', $1::text)`, [w.project, w.user]);
  await query(`INSERT INTO project_workspaces (id, project_id, worker_id, root_path) VALUES ($1, $2, $3, '/repo')`, [
    w.workspace, w.project, w.worker,
  ]);
  return w;
}

async function mainThread(w: World, provider = "claude"): Promise<string> {
  const thread = id();
  await query(
    `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, worker_id, workspace_id, cwd, status)
     VALUES ($1, $2, $3, 'main', $1, 'worker', $4, $5, $6, '/repo', 'idle')`,
    [thread, w.project, w.user, provider, w.worker, w.workspace],
  );
  return thread;
}

interface SideOptions {
  parent: string;
  root: string;
  depth?: number;
  provider?: string;
  cwd?: string;
  worker?: string;
  forkSource?: string | null;
  forkAfterTurn?: string | null;
}

function insertSide(w: World, o: SideOptions, thread = id()) {
  return {
    thread,
    sql: `INSERT INTO threads (id, project_id, owner_user_id, kind, parent_thread_id, root_thread_id, depth, runtime, provider,
                               worker_id, workspace_id, cwd, fork_source_thread_id, fork_after_turn_id, status)
          VALUES ($1, $2, $3, 'side', $4, $5, $6, 'worker', $7, $8, $9, $10, $11, $12, 'idle')`,
    params: [
      thread, w.project, w.user, o.parent, o.root, o.depth ?? 1, o.provider ?? "claude",
      o.worker ?? w.worker, w.workspace, o.cwd ?? "/repo", o.forkSource ?? null, o.forkAfterTurn ?? null,
    ],
  };
}

async function sideThread(w: World, o: SideOptions): Promise<string> {
  const side = insertSide(w, o);
  await query(side.sql, side.params);
  return side.thread;
}

/** Completed turn whose events are `texts`, appended after the thread's current last_seq. */
async function completedTurn(w: World, thread: string, texts: string[]): Promise<string> {
  const turn = id();
  const [row] = await query<{ next: number; seq: string }>(
    `SELECT coalesce(max(ordinal), 0) + 1 AS next, (SELECT last_seq FROM threads WHERE id = $1) AS seq FROM turns WHERE thread_id = $1`,
    [thread],
  );
  const first = Number(row!.seq) + 1;
  await query(
    `INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, input)
     VALUES ($1, $2, $3, 'running', 'user', $4, '{"text":"go"}')`,
    [turn, thread, row!.next, w.user],
  );
  for (const [i, text] of texts.entries()) {
    await insertItemEvent(thread, first + i, turn, `item-${text}`, text);
  }
  const last = first + texts.length - 1;
  await query(`UPDATE turns SET status = 'completed', first_seq = $2, last_seq = $3 WHERE id = $1`, [turn, first, last]);
  await query(`UPDATE threads SET last_seq = $2 WHERE id = $1`, [thread, last]);
  return turn;
}

/** An item_completed event plus its projection row, as the gateway writes them in one transaction. */
async function insertItemEvent(thread: string, seq: number, turn: string | null, itemId: string, text: string) {
  const item = { itemId, status: "ITEM_STATUS_COMPLETED", agentMessage: { text } };
  await query(
    `INSERT INTO thread_events (thread_id, seq, event_id, origin, turn_id, kind, item_id, payload, occurred_at)
     VALUES ($1, $2, $3, 'worker', $4, 'item_completed', $5, $6::jsonb, now())`,
    [thread, seq, id(), turn, itemId, JSON.stringify({ itemCompleted: { item } })],
  );
  await query(
    `INSERT INTO thread_items (thread_id, item_id, turn_id, type, status, content, first_seq, last_seq)
     VALUES ($1, $2, $3, 'agent_message', 'completed', $4::jsonb, $5, $5)
     ON CONFLICT (thread_id, item_id) DO UPDATE SET content = EXCLUDED.content, last_seq = EXCLUDED.last_seq`,
    [thread, itemId, turn, JSON.stringify(item), seq],
  );
}

async function timeline(thread: string): Promise<string[]> {
  const rows = await query<{ payload: { itemCompleted: { item: { agentMessage: { text: string } } } }; inherited: boolean }>(
    `SELECT * FROM thread_timeline($1)`,
    [thread],
  );
  return rows.map((r) => `${r.inherited ? "^" : ""}${r.payload.itemCompleted.item.agentMessage.text}`);
}

async function itemsView(thread: string): Promise<string[]> {
  const rows = await query<{ item_id: string; inherited: boolean; changed_after_fork: boolean }>(
    `SELECT * FROM thread_items_view($1)`,
    [thread],
  );
  return rows.map((r) => `${r.inherited ? "^" : ""}${r.item_id}${r.changed_after_fork ? "*" : ""}`);
}

// ------------------------------------------------------------------ tests

describe.skipIf(!dockerAvailable)("schema on PostgreSQL 17", () => {
  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(pg.layer);
    const applied = await runtime.runPromise(migrate);
    expect(applied.map(([n, name]) => `${n}_${name}`)).toEqual(["1_init", "2_worker_config", "3_gateway_runtime", "4_agent_bus_runtime", "5_settings", "6_turn_sources", "7_turn_source_details", "8_one_start_per_turn", "9_models_effort_steer", "10_goals_background_harness", "11_goals_engine_cleanup", "12_worker_restart", "13_turn_end_sources", "14_turn_permission_mode", "15_provider_profiles", "16_attachments", "18_global_providers", "19_thread_reads", "21_fork_from_turn"]);
  }, 60_000);

  afterAll(async () => {
    await runtime?.dispose();
    pg?.stop();
  });

  test("migrations are idempotent", async () => {
    expect(await runtime.runPromise(migrate)).toEqual([]);
  });

  describe("threads: placement", () => {
    test("worker threads need worker, workspace and cwd; gateway threads must not have them", async () => {
      const w = await world();
      expect(
        await failure(
          `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider)
           VALUES ($1, $2, $3, 'main', $1, 'worker', 'claude')`,
          [id(), w.project, w.user],
        ),
      ).toContain("threads_runtime_placement");
      expect(
        await failure(
          `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, cwd)
           VALUES ($1, $2, $3, 'main', $1, 'gateway', 'anthropic', '/repo')`,
          [id(), w.project, w.user],
        ),
      ).toContain("threads_runtime_placement");
      // Chat thread on the gateway: no worker, no directory.
      await query(
        `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider)
         VALUES ($1, $2, $3, 'main', $1, 'gateway', 'anthropic')`,
        [id(), w.project, w.user],
      );
    });

    test("the workspace must belong to the thread's project and worker", async () => {
      const w = await world();
      const other = await world();
      expect(
        await failure(
          `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, worker_id, workspace_id, cwd)
           VALUES ($1, $2, $3, 'main', $1, 'worker', 'codex', $4, $5, '/repo')`,
          [id(), w.project, w.user, w.worker, other.workspace],
        ),
      ).toContain("foreign key");
    });

    test("placement and lineage are immutable; provider_thread_id is set once, replaceable only before the first turn", async () => {
      const w = await world();
      const thread = await mainThread(w);
      expect(await failure(`UPDATE threads SET cwd = '/elsewhere' WHERE id = $1`, [thread])).toContain("immutable");
      expect(await failure(`UPDATE threads SET provider = 'codex' WHERE id = $1`, [thread])).toContain("immutable");
      await query(`UPDATE threads SET provider_thread_id = 'sess-1', status = 'running' WHERE id = $1`, [thread]);
      // No history yet (e.g. a Codex thread without a rollout, started again after a worker restart).
      await query(`UPDATE threads SET provider_thread_id = 'sess-2' WHERE id = $1`, [thread]);
      expect(await failure(`UPDATE threads SET provider_thread_id = NULL WHERE id = $1`, [thread])).toContain("set once");
      await query(`INSERT INTO turns (id, thread_id, ordinal, status, trigger, input, started_at) VALUES ($1, $2, 1, 'running', 'provider', '{}', now())`, [id(), thread]);
      expect(await failure(`UPDATE threads SET provider_thread_id = 'sess-3' WHERE id = $1`, [thread])).toContain("set once");
    });
  });

  describe("threads: side threads", () => {
    test("share worker and directory with the parent", async () => {
      const w = await world();
      const main = await mainThread(w);
      await sideThread(w, { parent: main, root: main });

      const otherCwd = insertSide(w, { parent: main, root: main, cwd: "/repo/sub" });
      expect(await failure(otherCwd.sql, otherCwd.params)).toContain("same worker and directory");
      const otherWorker = insertSide(w, { parent: main, root: main, worker: w.otherWorker });
      // Fails on the workspace FK (workspace is on worker 1) or on the trigger; either way it is rejected.
      expect(await failure(otherWorker.sql, otherWorker.params)).toMatch(/foreign key|same worker/);
    });

    test("tree bookkeeping: root and depth must match the parent; two levels only", async () => {
      const w = await world();
      const main = await mainThread(w);
      // The lineage trigger runs before CHECK constraints: a depth that does not match the parent is caught there.
      const wrongDepth = insertSide(w, { parent: main, root: main, depth: 2 });
      expect(await failure(wrongDepth.sql, wrongDepth.params)).toContain("share project, owner and tree");

      // A side thread (level 1) cannot have side threads of its own.
      const side = await sideThread(w, { parent: main, root: main });
      const nested = insertSide(w, { parent: side, root: main, depth: 2 });
      expect(await failure(nested.sql, nested.params)).toContain("threads_max_depth");
      const lying = insertSide(w, { parent: side, root: main, depth: 1 });
      expect(await failure(lying.sql, lying.params)).toContain("share project, owner and tree");
    });

    test("interaction routing to the parent agent exists only for side threads", async () => {
      const w = await world();
      expect(
        await failure(
          `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, worker_id, workspace_id, cwd, interaction_route)
           VALUES ($1, $2, $3, 'main', $1, 'worker', 'claude', $4, $5, '/repo', 'parent')`,
          [id(), w.project, w.user, w.worker, w.workspace],
        ),
      ).toContain("threads_parent_route");
    });

    test("a side thread without fork may use another provider (e.g. Codex reviewer on a Claude thread)", async () => {
      const w = await world();
      const main = await mainThread(w, "claude");
      await sideThread(w, { parent: main, root: main, provider: "codex" });
    });
  });

  describe("threads: forks", () => {
    test("fork keeps the provider and needs a completed turn", async () => {
      const w = await world();
      const main = await mainThread(w, "claude");

      const noTurn = insertSide(w, { parent: main, root: main, forkSource: main });
      expect(await failure(noTurn.sql, noTurn.params)).toContain("no completed turn");

      await completedTurn(w, main, ["a"]);
      const crossProvider = insertSide(w, { parent: main, root: main, provider: "codex", forkSource: main });
      expect(await failure(crossProvider.sql, crossProvider.params)).toContain("keep the provider");
    });

    test("fork point is pinned at insert to the latest completed turn", async () => {
      const w = await world();
      const main = await mainThread(w);
      await completedTurn(w, main, ["a"]);
      const second = await completedTurn(w, main, ["b"]);
      const fork = await sideThread(w, { parent: main, root: main, forkSource: main });

      const [row] = await query<{ fork_after_turn_id: string }>(`SELECT fork_after_turn_id FROM threads WHERE id = $1`, [fork]);
      expect(row?.fork_after_turn_id).toBe(second);
    });

    test("fork point must be a completed turn of the source thread", async () => {
      const w = await world();
      const main = await mainThread(w);
      const other = await mainThread(w);
      const foreignTurn = await completedTurn(w, other, ["x"]);
      await completedTurn(w, main, ["a"]);
      const bad = insertSide(w, { parent: main, root: main, forkSource: main, forkAfterTurn: foreignTurn });
      expect(await failure(bad.sql, bad.params)).toMatch(/ended turn of the source|foreign key/);
    });

    test("fork from a turn: a main thread in its own tree, at any ended turn, never a running one", async () => {
      const w = await world();
      const main = await mainThread(w);
      const t1 = await completedTurn(w, main, ["m1"]);
      const t2 = await completedTurn(w, main, ["m2"]);
      await completedTurn(w, main, ["m3"]);
      await query(`UPDATE turns SET status = 'failed' WHERE id = $1`, [t2]);
      const insertMainFork = (afterTurn: string, worker = w.worker) => {
        const thread = id();
        return {
          thread,
          sql: `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, worker_id, workspace_id, cwd,
                                     fork_source_thread_id, fork_after_turn_id, status)
                VALUES ($1, $2, $3, 'main', $1, 'worker', 'claude', $4, $5, '/repo', $6, $7, 'idle')`,
          params: [thread, w.project, w.user, worker, w.workspace, main, afterTurn],
        };
      };

      const atFailed = insertMainFork(t2);
      await query(atFailed.sql, atFailed.params);
      expect(await timeline(atFailed.thread)).toEqual(["^m1", "^m2"]);

      const running = id();
      await query(
        `INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, input) VALUES ($1, $2, 4, 'running', 'user', $3, '{}')`,
        [running, main, w.user],
      );
      const atRunning = insertMainFork(running);
      expect(await failure(atRunning.sql, atRunning.params)).toContain("ended turn of the source");

      const elsewhere = insertMainFork(t1, w.otherWorker);
      expect(await failure(elsewhere.sql, elsewhere.params)).toMatch(/share project, owner and worker|workspace/);
    });

    test("thread_timeline: inherited prefix (recursively) + own events, unaffected by later source events", async () => {
      const w = await world();
      const main = await mainThread(w);
      const t1 = await completedTurn(w, main, ["m1", "m2"]);
      await completedTurn(w, main, ["m3"]);

      const side = await sideThread(w, { parent: main, root: main, forkSource: main, forkAfterTurn: t1 });
      await completedTurn(w, side, ["s1"]);
      // The main thread keeps going; the side thread must not see it.
      await completedTurn(w, main, ["m4"]);

      // Fork of a fork: a sibling (still level 1) that inherits the side thread's history.
      const nested = await sideThread(w, { parent: main, root: main, forkSource: side });
      await completedTurn(w, nested, ["n1"]);

      expect(await timeline(main)).toEqual(["m1", "m2", "m3", "m4"]);
      expect(await timeline(side)).toEqual(["^m1", "^m2", "s1"]);
      expect(await timeline(nested)).toEqual(["^m1", "^m2", "^s1", "n1"]);
    });
  });

  describe("turns", () => {
    test("at most one running turn per thread", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const insert = `INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, input)
                      VALUES ($1, $2, $3, 'running', 'user', $4, '{}')`;
      await query(insert, [id(), thread, 1, w.user]);
      expect(await failure(insert, [id(), thread, 2, w.user])).toContain("turns_one_running");
    });

    test("client_request_id deduplicates retried user input", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const insert = `INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, client_request_id, input)
                      VALUES ($1, $2, $3, 'user', $4, 'req-1', '{}') ON CONFLICT DO NOTHING RETURNING id`;
      expect(await query(insert, [id(), thread, 1, w.user])).toHaveLength(1);
      expect(await query(insert, [id(), thread, 2, w.user])).toHaveLength(0);
    });

    test("provider-started turns: never queued, no user; recovery points at the interrupted turn of the same thread", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const other = await mainThread(w);
      const insert = `INSERT INTO turns (id, thread_id, ordinal, status, trigger, author_user_id, resumes_turn_id, input)
                      VALUES ($1, $2, $3, $4, $5, $6, $7, '{}')`;
      // Wake-up after a background task: started by the provider, reported by the worker.
      await query(insert, [id(), thread, 1, "interrupted", "provider", null, null]);
      expect(await failure(insert, [id(), thread, 2, "queued", "provider", null, null])).toContain("turns_provider_not_queued");
      expect(await failure(insert, [id(), thread, 2, "running", "provider", w.user, null])).toContain("turns_user_author");

      const interrupted = id();
      await query(insert, [interrupted, thread, 2, "interrupted", "user", w.user, null]);
      await query(insert, [id(), thread, 3, "running", "recovery", null, interrupted]);
      expect(await failure(insert, [id(), thread, 4, "failed", "recovery", null, null])).toContain("turns_recovery_link");
      const foreign = id();
      await query(insert, [foreign, other, 1, "interrupted", "user", w.user, null]);
      expect(await failure(insert, [id(), thread, 4, "failed", "recovery", null, foreign])).toContain("foreign key");
    });

    test("interactions: outcome must fit the kind; pending has no answer time", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const insert = `INSERT INTO interaction_requests (id, thread_id, kind, request, status, answered_at, routed_to, answered_by)
                      VALUES ($1, $2, $3, '{}', $4, $5, 'human', CASE WHEN $4 IN ('allowed', 'declined', 'answered') THEN $6::uuid END)`;
      // A background task may ask after the turn ended: no turn_id.
      await query(insert, [id(), thread, "permission", "pending", null, w.user]);
      await query(insert, [id(), thread, "question", "answered", new Date(), w.user]);
      expect(await failure(insert, [id(), thread, "question", "allowed", new Date(), w.user])).toContain("interaction_requests_decision_is_permission");
      expect(await failure(insert, [id(), thread, "permission", "answered", new Date(), w.user])).toContain("interaction_requests_permission_not_answered");
      expect(await failure(insert, [id(), thread, "permission", "pending", new Date(), w.user])).toContain("interaction_requests_answer_time");
    });

    test("interactions answered by the parent agent: routed to parent, exactly one author", async () => {
      const w = await world();
      const main = await mainThread(w);
      const side = await sideThread(w, { parent: main, root: main });
      const insert = `INSERT INTO interaction_requests (id, thread_id, kind, request, status, answered_at, routed_to, answered_by, answered_by_thread_id)
                      VALUES ($1, $2, 'permission', '{}', $3, now(), $4, $5, $6)`;
      await query(insert, [id(), side, "allowed", "parent", null, main]); // the parent agent decided
      await query(insert, [id(), side, "declined", "parent", w.user, null]); // the user stepped in
      await query(insert, [id(), side, "expired", "parent", null, null]); // nobody answered in time
      expect(await failure(insert, [id(), side, "allowed", "parent", null, null])).toContain("interaction_requests_answered_by");
      expect(await failure(insert, [id(), side, "allowed", "parent", w.user, main])).toContain("interaction_requests_answered_by");
      expect(await failure(insert, [id(), side, "allowed", "human", null, main])).toContain("interaction_requests_agent_answer_routed");
    });

    test("events must reference a turn of the same thread", async () => {
      const w = await world();
      const a = await mainThread(w);
      const b = await mainThread(w);
      const turnOfB = await completedTurn(w, b, ["x"]);
      expect(
        await failure(
          `INSERT INTO thread_events (thread_id, seq, event_id, origin, turn_id, kind, payload, occurred_at)
           VALUES ($1, 1, $2, 'worker', $3, 'notice', '{}', now())`,
          [a, id(), turnOfB],
        ),
      ).toContain("foreign key");
    });
  });

  describe("transcript", () => {
    const insertEvent = `INSERT INTO thread_events (thread_id, seq, event_id, origin, turn_id, kind, item_id, payload, occurred_at)
                         VALUES ($1, $2, $3, $4, NULL, $5, $6, '{}', now()) ON CONFLICT (thread_id, event_id) DO NOTHING RETURNING seq`;

    test("events between turns are recorded (turn_id NULL), from both worker and gateway", async () => {
      const w = await world();
      const thread = await mainThread(w);
      await completedTurn(w, thread, ["a"]);
      expect(await query(insertEvent, [thread, 2, id(), "worker", "item_started", "bg-task-1"])).toHaveLength(1);
      expect(await query(insertEvent, [thread, 3, id(), "gateway", "notice", null])).toHaveLength(1);
      const kinds = await query<{ kind: string; turn_id: string | null }>(
        `SELECT kind, turn_id FROM thread_timeline($1)`,
        [thread],
      );
      expect(kinds.map((k) => [k.kind, k.turn_id === null])).toEqual([
        ["item_completed", false],
        ["item_started", true],
        ["notice", true],
      ]);
    });

    test("a resent event (same event_id) is ignored", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const eventId = id();
      expect(await query(insertEvent, [thread, 1, eventId, "worker", "notice", null])).toHaveLength(1);
      expect(await query(insertEvent, [thread, 2, eventId, "worker", "notice", null])).toHaveLength(0);
    });

    test("item events carry item_id, other events do not", async () => {
      const w = await world();
      const thread = await mainThread(w);
      expect(await failure(insertEvent, [thread, 1, id(), "worker", "item_delta", null])).toContain("thread_events_item_id");
      expect(await failure(insertEvent, [thread, 1, id(), "worker", "notice", "x"])).toContain("thread_events_item_id");
    });

    test("thread_items_view: inherited items up to the fork point, flags items that changed later", async () => {
      const w = await world();
      const main = await mainThread(w);
      await completedTurn(w, main, ["m1"]);
      // A background task starts in turn 2 and keeps running after the fork point.
      const t2 = await completedTurn(w, main, ["m2"]);
      await insertItemEvent(main, 3, null, "bg", "started");
      await query(`UPDATE turns SET last_seq = 3 WHERE id = $1`, [t2]);
      await query(`UPDATE threads SET last_seq = 3 WHERE id = $1`, [main]);

      const side = await sideThread(w, { parent: main, root: main, forkSource: main });
      await completedTurn(w, side, ["s1"]);
      await insertItemEvent(main, 4, null, "bg", "finished");
      await query(`UPDATE threads SET last_seq = 4 WHERE id = $1`, [main]);
      await completedTurn(w, main, ["m3"]);

      expect(await itemsView(side)).toEqual(["^item-m1", "^item-m2", "^bg*", "item-s1"]);
      expect(await itemsView(main)).toEqual(["item-m1", "item-m2", "bg", "item-m3"]);
    });

    test("blobs are content-addressed and stored inline or externally, not both", async () => {
      const insert = `INSERT INTO blobs (sha256, size_bytes, data, storage_url) VALUES ($1, 3, $2, $3)`;
      const sha = "a".repeat(64);
      await query(insert, [sha, new Uint8Array([1, 2, 3]), null]);
      expect(await failure(insert, ["b".repeat(64), null, null])).toContain("blobs_one_location");
      expect(await failure(insert, ["not-a-hash", new Uint8Array([1]), null])).toContain("blobs_sha256_check");
    });

    test("attachments: a blob owned by a user, a safe name, bound to a thread and turn together", async () => {
      const w = await world();
      const sha = "c".repeat(64);
      await query(`INSERT INTO blobs (sha256, size_bytes, data) VALUES ($1, 1, $2)`, [sha, new Uint8Array([1])]);
      const insert = `INSERT INTO attachments (id, owner_user_id, sha256, name, mime_type, kind, size_bytes, thread_id, turn_id)
                      VALUES ($1, $2, $3, $4, 'text/plain', $5, 1, $6, $7)`;
      await query(insert, [id(), w.user, sha, "notes.txt", "file", null, null]);
      expect(await failure(insert, [id(), w.user, "d".repeat(64), "x.txt", "file", null, null])).toContain("attachments_sha256_fkey");
      expect(await failure(insert, [id(), w.user, sha, "../x.txt", "file", null, null])).toContain("attachments_name_check");
      expect(await failure(insert, [id(), w.user, sha, "a\\b", "file", null, null])).toContain("attachments_name_check");
      expect(await failure(insert, [id(), w.user, sha, "..", "file", null, null])).toContain("attachments_name_check");
      expect(await failure(insert, [id(), w.user, sha, "x.exe", "program", null, null])).toContain("attachments_kind_check");
      const main = await mainThread(w);
      expect(await failure(insert, [id(), w.user, sha, "x.txt", "file", main, null])).toContain("attachments_bound_together");
      expect(await failure(`INSERT INTO thread_blobs (thread_id, sha256) VALUES ($1, 'nope')`, [main])).toContain("thread_blobs_sha256_check");
    });
  });

  describe("agent bus", () => {
    const insertCall = `INSERT INTO agent_bus_calls (id, source_thread_id, source_turn_id, tool, arguments, hops, notify, notify_status)
                        VALUES ($1, $2, $3, $4, '{}', $5, $6, $7)`;
    const insertBusTurn = `INSERT INTO turns (id, thread_id, ordinal, status, trigger, agent_call_id, hops, input)
                           VALUES ($1, $2, $3, $4, 'agent_bus', $5, $6, '{}')`;

    test("spawn: call -> agent side thread -> turn (hops 1) -> notify turn back in the caller (hops 2)", async () => {
      const w = await world();
      const main = await mainThread(w);
      const callerTurn = await completedTurn(w, main, ["plan"]);

      const call = id();
      await query(insertCall, [call, main, callerTurn, "spawn_thread", 1, true, "pending"]);
      const side = id();
      await query(
        `INSERT INTO threads (id, project_id, owner_user_id, kind, parent_thread_id, root_thread_id, depth, origin, spawned_by_call_id,
                              runtime, provider, worker_id, workspace_id, cwd, status)
         VALUES ($1, $2, $3, 'side', $4, $4, 1, 'agent', $5, 'worker', 'codex', $6, $7, '/repo', 'idle')`,
        [side, w.project, w.user, main, call, w.worker, w.workspace],
      );
      const sideTurn = id();
      await query(insertBusTurn, [sideTurn, side, 1, "running", call, 1]);
      await query(`UPDATE agent_bus_calls SET target_thread_id = $2, target_turn_id = $3, status = 'completed', completed_at = now() WHERE id = $1`, [
        call, side, sideTurn,
      ]);

      // The side thread finished: deliver the notification as a new turn in the caller.
      const notifyTurn = id();
      await query(insertBusTurn, [notifyTurn, main, 2, "queued", call, 2]);
      await query(`UPDATE agent_bus_calls SET notify_status = 'delivered', notified_turn_id = $2 WHERE id = $1`, [call, notifyTurn]);

      const [row] = await query<{ origin: string; spawned_by_call_id: string }>(`SELECT origin, spawned_by_call_id FROM threads WHERE id = $1`, [side]);
      expect(row).toEqual({ origin: "agent", spawned_by_call_id: call });
    });

    test("integrity rules", async () => {
      const w = await world();
      const main = await mainThread(w);
      const other = await mainThread(w);
      const turn = await completedTurn(w, main, ["x"]);
      const otherTurn = await completedTurn(w, other, ["y"]);

      // Agent-created thread must point at its spawn call.
      expect(
        await failure(
          `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, origin, runtime, provider, worker_id, workspace_id, cwd)
           VALUES ($1, $2, $3, 'main', $1, 'agent', 'worker', 'claude', $4, $5, '/repo')`,
          [id(), w.project, w.user, w.worker, w.workspace],
        ),
      ).toContain("threads_agent_origin");
      // Only spawn/send start turns and carry hops; notify only for them.
      expect(await failure(insertCall, [id(), main, turn, "send_message", null, false, null])).toContain("agent_bus_calls_starts_turn");
      expect(await failure(insertCall, [id(), main, turn, "get_thread", 1, false, null])).toContain("agent_bus_calls_starts_turn");
      expect(await failure(insertCall, [id(), main, turn, "get_thread", null, true, "pending"])).toContain("agent_bus_calls_notify");
      expect(await failure(insertCall, [id(), main, turn, "send_message", 1, true, null])).toContain("agent_bus_calls_notify");
      expect(await failure(insertCall, [id(), main, turn, "send_message", 1, true, "delivered"])).toContain("agent_bus_calls_notify");
      expect(await failure(insertCall, [id(), main, turn, "send_message", 17, false, null])).toContain("agent_bus_calls_hops_check");
      // Goals are the harness's own: the bus has no goal tools (0011).
      expect(await failure(insertCall, [id(), main, turn, "propose_goal", null, false, null])).toContain("agent_bus_calls_tool_check");

      // A bus turn has hops > 0, a human turn has 0.
      const call = id();
      await query(insertCall, [call, main, turn, "send_message", 1, false, null]);
      expect(await failure(insertBusTurn, [id(), main, 2, "queued", call, 0])).toContain("turns_hops_by_trigger");
      // The notification turn must be in the caller's thread.
      const notified = id();
      await query(insertCall, [notified, main, turn, "send_message", 1, true, "pending"]);
      expect(
        await failure(`UPDATE agent_bus_calls SET notify_status = 'delivered', notified_turn_id = $2 WHERE id = $1`, [notified, otherTurn]),
      ).toContain("foreign key");
    });

    test("a turn end says its source: failed -> platform | harness, interrupted -> user | system (0013)", async () => {
      const w = await world();
      const main = await mainThread(w);
      const turn = await completedTurn(w, main, ["x"]);
      expect(await failure(`UPDATE turns SET error_source = 'harness' WHERE id = $1`, [turn])).toContain("turns_error_source_failed");
      expect(await failure(`UPDATE turns SET interrupt_source = 'system' WHERE id = $1`, [turn])).toContain("turns_interrupt_source_interrupted");
      expect(await failure(`UPDATE turns SET status = 'failed', error_source = 'model' WHERE id = $1`, [turn])).toContain("turns_error_source_check");
      await query(`UPDATE turns SET status = 'failed', error = 'unexpected status 401', error_source = 'harness', error_code = 'http_connection_failed:401' WHERE id = $1`, [turn]);
      await query(`UPDATE turns SET status = 'interrupted', error = NULL, error_source = NULL, error_code = NULL, interrupt_source = 'system' WHERE id = $1`, [turn]);
    });
  });

  describe("schedules", () => {
    const insertSchedule = `INSERT INTO schedules (id, thread_id, kind, prompt, run_at, cron, until, max_runs, next_run_at,
                                                   created_by_user_id, created_by_call_id, hops)
                            VALUES ($1, $2, $3, 'check CI', $4, $5, $6, $7, $8, $9, $10, $11)`;
    const soon = () => new Date(Date.now() + 600_000);

    test("user schedules may be open-ended; agent schedules must be bounded and extend the chain", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const turn = await completedTurn(w, thread, ["x"]);
      const call = id();
      await query(
        `INSERT INTO agent_bus_calls (id, source_thread_id, source_turn_id, tool, arguments) VALUES ($1, $2, $3, 'schedule_recurring', '{}')`,
        [call, thread, turn],
      );

      await query(insertSchedule, [id(), thread, "recurring", null, "0 9 * * 1-5", null, null, soon(), w.user, null, 0]);
      await query(insertSchedule, [id(), thread, "recurring", null, "*/30 * * * *", null, 10, soon(), null, call, 1]);
      await query(insertSchedule, [id(), thread, "once", soon(), null, null, null, soon(), null, call, 1]);

      expect(await failure(insertSchedule, [id(), thread, "recurring", null, "*/30 * * * *", null, null, soon(), null, call, 1])).toContain(
        "schedules_agent_bounded",
      );
      expect(await failure(insertSchedule, [id(), thread, "once", soon(), null, null, null, soon(), null, call, 0])).toContain(
        "schedules_agent_bounded",
      );
      expect(await failure(insertSchedule, [id(), thread, "once", soon(), null, null, null, soon(), w.user, null, 2])).toContain(
        "schedules_user_hops",
      );
      expect(await failure(insertSchedule, [id(), thread, "once", soon(), null, null, null, soon(), null, null, 0])).toContain(
        "schedules_one_creator",
      );
      expect(await failure(insertSchedule, [id(), thread, "once", null, "0 9 * * *", null, null, soon(), w.user, null, 0])).toContain(
        "schedules_kind_fields",
      );
      expect(await failure(insertSchedule, [id(), thread, "once", soon(), null, null, null, null, w.user, null, 0])).toContain(
        "schedules_active_has_next",
      );
    });

    test("a fired schedule is a turn with trigger = schedule", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const schedule = id();
      await query(insertSchedule, [schedule, thread, "once", soon(), null, null, null, soon(), w.user, null, 0]);
      const insertTurn = `INSERT INTO turns (id, thread_id, ordinal, trigger, schedule_id, hops, input) VALUES ($1, $2, $3, $4, $5, 0, '{}')`;
      await query(insertTurn, [id(), thread, 1, "schedule", schedule]);
      expect(await failure(insertTurn, [id(), thread, 2, "schedule", null])).toContain("turns_schedule");
      expect(await failure(insertTurn, [id(), thread, 2, "user", schedule])).toContain("turns_");
    });
  });

  describe("goals", () => {
    const insertGoal = `INSERT INTO goals (id, thread_id, objective, status, created_by, created_by_user_id, token_budget, finished_at)
                        VALUES ($1, $2, 'Migrate auth', $3, $4, $5, $6, $7)`;

    test("one open goal per thread; finished goals do not block a new one", async () => {
      const w = await world();
      const thread = await mainThread(w);
      await query(insertGoal, [id(), thread, "achieved", "user", w.user, null, new Date()]);
      await query(insertGoal, [id(), thread, "active", "user", w.user, null, null]);
      expect(await failure(insertGoal, [id(), thread, "paused", "user", w.user, null, null])).toContain("goals_one_open");
    });

    test("goals the harness set by itself are tracked as they are (no approval or budget gate)", async () => {
      const w = await world();
      // Codex create_goal: the model set it, the platform records it (docs/goals.md).
      await query(insertGoal, [id(), (await mainThread(w)), "active", "provider", null, null, null]);
      await query(insertGoal, [id(), (await mainThread(w)), "active", "provider", null, 200_000, null]);
      // Users may set open-ended goals directly.
      await query(insertGoal, [id(), (await mainThread(w)), "active", "user", w.user, null, null]);
    });

    test("creator columns and finish time are consistent", async () => {
      const w = await world();
      expect(await failure(insertGoal, [id(), (await mainThread(w)), "active", "user", null, null, null])).toContain("goals_creator");
      expect(await failure(insertGoal, [id(), (await mainThread(w)), "active", "provider", w.user, null, null])).toContain("goals_creator");
      expect(await failure(insertGoal, [id(), (await mainThread(w)), "achieved", "user", w.user, null, null])).toContain(
        "goals_finished",
      );
    });

    test("no platform engine: no agent proposals, approvals or platform budgets (0011)", async () => {
      const w = await world();
      expect(await failure(insertGoal, [id(), (await mainThread(w)), "active", "agent", null, 100_000, null])).toContain("goals_creator");
      expect(await failure(insertGoal, [id(), (await mainThread(w)), "proposed", "user", w.user, null, null])).toContain("goals_status_check");
      const columns = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'goals' ORDER BY ordinal_position`,
      );
      expect(columns.map((c) => c.column_name)).toEqual([
        "id",
        "thread_id",
        "objective",
        "status",
        "token_budget",
        "tokens_used",
        "time_used_seconds",
        "turns_used",
        "last_reason",
        "native_state",
        "created_by",
        "created_by_user_id",
        "created_at",
        "updated_at",
        "finished_at",
        "native_status",
        "error",
        "error_at",
      ]);
    });

    test("goal turns (Claude /goal) point at their goal and do not count as hops", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const goal = id();
      await query(insertGoal, [goal, thread, "active", "user", w.user, null, null]);
      const insertTurn = `INSERT INTO turns (id, thread_id, ordinal, trigger, goal_id, hops, input) VALUES ($1, $2, $3, 'goal', $4, $5, '{}')`;
      await query(insertTurn, [id(), thread, 1, goal, 0]);
      expect(await failure(insertTurn, [id(), thread, 2, null, 0])).toContain("turns_goal");
      expect(await failure(insertTurn, [id(), thread, 2, goal, 1])).toContain("turns_hops_by_trigger");
    });
  });

  describe("worker configuration (0002)", () => {
    const upsert = `INSERT INTO worker_configs (worker_id, version, config, updated_by) VALUES ($1, $2, $3::jsonb, $4)
                    ON CONFLICT (worker_id) DO UPDATE SET version = EXCLUDED.version, config = EXCLUDED.config, updated_at = now()`;

    test("every new version lands in history; a change without a higher version is refused", async () => {
      const w = await world();
      await query(upsert, [w.worker, 1, '{"allowedRoots":["/a"]}', w.user]);
      await query(upsert, [w.worker, 2, '{"allowedRoots":["/a","/b"]}', w.user]);
      expect(await failure(upsert, [w.worker, 2, '{"allowedRoots":[]}', w.user])).toContain("higher version");
      expect(await failure(upsert, [w.worker, 1, '{"allowedRoots":["/a","/b"]}', w.user])).toContain("cannot go back");
      const history = await query<{ version: string }>(
        `SELECT version FROM worker_config_history WHERE worker_id = $1 ORDER BY version`,
        [w.worker],
      );
      expect(history.map((h) => Number(h.version))).toEqual([1, 2]);
    });

    test("the applied report cannot be ahead of the sent version and is recorded as a whole", async () => {
      const w = await world();
      await query(upsert, [w.worker, 3, "{}", w.user]);
      const apply = `UPDATE worker_configs SET applied_version = $2, applied_ok = $3, applied_at = $4 WHERE worker_id = $1`;
      expect(await failure(apply, [w.worker, 4, true, new Date()])).toContain("worker_configs_applied_not_ahead");
      expect(await failure(apply, [w.worker, 3, true, null])).toContain("worker_configs_applied_together");
      await query(apply, [w.worker, 3, false, new Date()]);
    });

    test("secrets: unique name per owner (platform-wide too); a secret in use cannot be deleted", async () => {
      const w = await world();
      const insertSecret = `INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by) VALUES ($1, $2, $3, '\\x00', 'k1', $4)`;
      const secret = id();
      await query(insertSecret, [secret, w.user, "cliproxy-key", w.user]);
      expect(await failure(insertSecret, [id(), w.user, "cliproxy-key", w.user])).toContain("secrets_owner_name");
      await query(insertSecret, [id(), null, `platform-${secret.slice(-6)}`, w.user]);
      expect(await failure(insertSecret, [id(), null, `platform-${secret.slice(-6)}`, w.user])).toContain("secrets_owner_name");
      expect(await failure(insertSecret, [id(), w.user, "Bad Name!", w.user])).toContain("secrets_name_check");

      await query(upsert, [w.worker, 1, `{"profiles":[{"id":"proxy","apiKey":{"secretRef":"${secret}"}}]}`, w.user]);
      await query(`INSERT INTO worker_config_secrets (worker_id, secret_id) VALUES ($1, $2)`, [w.worker, secret]);
      expect(await failure(`DELETE FROM secrets WHERE id = $1`, [secret])).toContain("foreign key");
    });
  });

  describe("agents", () => {
    test("scope/owner and kind/provider are consistent", async () => {
      const w = await world();
      const insert = `INSERT INTO agents (id, scope, owner_user_id, kind, provider, name, slug, created_by)
                      VALUES ($1::uuid, $2, $3, $4, $5, 'A', $1::text, $6)`;
      expect(await failure(insert, [id(), "global", w.user, "sdk", "claude", w.user])).toContain("agents_scope_owner");
      expect(await failure(insert, [id(), "private", w.user, "sdk", "anthropic", w.user])).toContain("agents_kind_provider");
      await query(insert, [id(), "global", null, "sdk", "codex", w.user]);
      await query(insert, [id(), "private", w.user, "chat", "openai", w.user]);
    });
  });
});
