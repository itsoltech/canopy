/** Shared fixtures of the schema tests: one throwaway PostgreSQL per test file, migrated, plus row builders. */
import { Effect, ManagedRuntime } from "effect";
import { SqlClient, type SqlConnection } from "effect/sql";
import { migrate } from "../../src/index.ts";
import { startPostgres, type TestPostgres } from "../../src/testing.ts";

export const id = () => Bun.randomUUIDv7();

let pg: TestPostgres | undefined;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown> | undefined;

/** Starts a throwaway PostgreSQL 17 and applies every migration; returns the applied ones. */
export async function startSchemaDb(): Promise<ReadonlyArray<readonly [number, string]>> {
  pg = await startPostgres();
  runtime = ManagedRuntime.make(pg.layer);

  return runMigrations();
}

export async function stopSchemaDb(): Promise<void> {
  await runtime?.dispose();
  pg?.stop();
  runtime = undefined;
  pg = undefined;
}

/** Applies pending migrations (none after startSchemaDb). */
export function runMigrations(): Promise<ReadonlyArray<readonly [number, string]>> {
  return started().runPromise(migrate);
}

function started(): ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown> {
  if (!runtime) throw new Error("startSchemaDb() first");

  return runtime;
}

/** Runs a query and returns its rows. */
export function query<A extends object = SqlConnection.Row>(
  text: string,
  params: unknown[] = [],
): Promise<ReadonlyArray<A>> {
  return started().runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.unsafe<A>(text, params);
    }),
  );
}

const hasMessage = (value: unknown): value is { message: string } =>
  value instanceof Object && "message" in value && typeof value.message === "string";

const hasConstraint = (value: unknown): value is { constraint: string } =>
  value instanceof Object && "constraint" in value && typeof value.constraint === "string";

/** Expects the statement to fail and returns the database error message. */
export async function failure(text: string, params: unknown[] = []): Promise<string> {
  const error = await query(text, params).then(
    () => undefined,
    (cause: unknown) => cause,
  );

  if (error === undefined) throw new Error(`expected failure: ${text}`);
  // SqlError -> reason -> driver error; collect every message plus the constraint name.
  const messages: string[] = [];

  for (let current: unknown = error; current instanceof Object; current = (current as { cause?: unknown }).cause) {
    if (hasMessage(current)) messages.push(current.message);

    if (hasConstraint(current)) messages.push(current.constraint);
  }

  return messages.join(" | ");
}

// ------------------------------------------------------------------ fixtures

export interface World {
  user: string;
  worker: string;
  otherWorker: string;
  project: string;
  workspace: string;
}

export async function world(): Promise<World> {
  const w = { user: id(), worker: id(), otherWorker: id(), project: id(), workspace: id() };
  await query(`INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'U', 'user')`, [
    w.user,
    `${w.user}@x`,
  ]);
  await query(
    `INSERT INTO workers (id, owner_user_id, name, credential_hash) VALUES ($1, $3, 'w1', 'h'), ($2, $3, 'w2', 'h')`,
    [w.worker, w.otherWorker, w.user],
  );
  await query(`INSERT INTO projects (id, owner_user_id, name, slug) VALUES ($1::uuid, $2, 'P', $1::text)`, [
    w.project,
    w.user,
  ]);
  await query(`INSERT INTO project_workspaces (id, project_id, worker_id, root_path) VALUES ($1, $2, $3, '/repo')`, [
    w.workspace,
    w.project,
    w.worker,
  ]);

  return w;
}

export async function mainThread(w: World, provider = "claude"): Promise<string> {
  const thread = id();
  await query(
    `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, worker_id, workspace_id, cwd, status)
     VALUES ($1, $2, $3, 'main', $1, 'worker', $4, $5, $6, '/repo', 'idle')`,
    [thread, w.project, w.user, provider, w.worker, w.workspace],
  );

  return thread;
}

export interface SideOptions {
  parent: string;
  root: string;
  depth?: number;
  provider?: string;
  cwd?: string;
  worker?: string;
  forkSource?: string | null;
  forkAfterTurn?: string | null;
}

export function insertSide(w: World, o: SideOptions, thread = id()) {
  return {
    thread,
    sql: `INSERT INTO threads (id, project_id, owner_user_id, kind, parent_thread_id, root_thread_id, depth, runtime, provider,
                               worker_id, workspace_id, cwd, fork_source_thread_id, fork_after_turn_id, status)
          VALUES ($1, $2, $3, 'side', $4, $5, $6, 'worker', $7, $8, $9, $10, $11, $12, 'idle')`,
    params: [
      thread,
      w.project,
      w.user,
      o.parent,
      o.root,
      o.depth ?? 1,
      o.provider ?? "claude",
      o.worker ?? w.worker,
      w.workspace,
      o.cwd ?? "/repo",
      o.forkSource ?? null,
      o.forkAfterTurn ?? null,
    ],
  };
}

export async function sideThread(w: World, o: SideOptions): Promise<string> {
  const side = insertSide(w, o);
  await query(side.sql, side.params);

  return side.thread;
}

/** Completed turn whose events are `texts`, appended after the thread's current last_seq. */
export async function completedTurn(w: World, thread: string, texts: string[]): Promise<string> {
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
  await query(`UPDATE turns SET status = 'completed', first_seq = $2, last_seq = $3 WHERE id = $1`, [
    turn,
    first,
    last,
  ]);
  await query(`UPDATE threads SET last_seq = $2 WHERE id = $1`, [thread, last]);

  return turn;
}

/** An item_completed event plus its projection row, as the gateway writes them in one transaction. */
export async function insertItemEvent(thread: string, seq: number, turn: string | null, itemId: string, text: string) {
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

export async function timeline(thread: string): Promise<string[]> {
  const rows = await query<{
    payload: { itemCompleted: { item: { agentMessage: { text: string } } } };
    inherited: boolean;
  }>(`SELECT * FROM thread_timeline($1)`, [thread]);

  return rows.map((r) => `${r.inherited ? "^" : ""}${r.payload.itemCompleted.item.agentMessage.text}`);
}

export async function itemsView(thread: string): Promise<string[]> {
  const rows = await query<{ item_id: string; inherited: boolean; changed_after_fork: boolean }>(
    `SELECT * FROM thread_items_view($1)`,
    [thread],
  );

  return rows.map((r) => `${r.inherited ? "^" : ""}${r.item_id}${r.changed_after_fork ? "*" : ""}`);
}
