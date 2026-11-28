import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Invalid, TRANSFER_BUSY } from "../store/errors.ts";

/** What a thread transfer waits for and what waits for it (docs/thread-transfers.md). */

type Sql = SqlClient.SqlClient;

/** Why the family can't move now; empty when it can. */
export function familyBlocker(sql: Sql, owner: string, family: readonly string[]) {
  return Effect.gen(function* () {
    const [row] = yield* sql.unsafe<{ reason: string }>(
      `SELECT CASE
      WHEN EXISTS (SELECT 1 FROM threads WHERE id = ANY($1::uuid[]) AND (owner_user_id <> $2::uuid OR deleted_at IS NOT NULL
        OR moved_to IS NOT NULL OR runtime <> 'worker')) THEN 'This thread can''t move.'
      WHEN EXISTS (SELECT 1 FROM threads WHERE id = ANY($1::uuid[]) AND transfer_pending_id IS NOT NULL) THEN '${TRANSFER_BUSY}'
      WHEN EXISTS (SELECT 1 FROM thread_transfers WHERE thread_id = ANY($1::uuid[]) AND state = 'aborted' AND cleanup_pending)
        THEN 'The last move of this thread is still being undone on the workers. Try again in a moment.'
      WHEN EXISTS (SELECT 1 FROM threads WHERE id = ANY($1::uuid[]) AND (rewind_pending_id IS NOT NULL
        OR preparation_fingerprint IS NOT NULL)) THEN 'Wait for the thread to finish preparing, then move.'
      WHEN EXISTS (SELECT 1 FROM threads WHERE id = ANY($1::uuid[])
        AND nullif(settings->'sandboxProfile','null'::jsonb) IS NOT NULL)
        THEN 'Threads with a sandbox profile stay on their worker.'
      WHEN EXISTS (SELECT 1 FROM threads WHERE id = ANY($1::uuid[]) AND provider NOT IN ('claude','codex'))
        THEN 'Only Claude and Codex threads can continue in another folder.'
      WHEN EXISTS (SELECT 1 FROM threads WHERE id = ANY($1::uuid[]) AND provider_thread_id IS NULL)
        THEN 'Send a first message before moving this thread.'
      WHEN EXISTS (SELECT 1 FROM turns WHERE thread_id = ANY($1::uuid[]) AND status IN ('queued','running'))
        THEN 'A turn is running or queued. Wait for it to finish or stop it, then move.'
      WHEN EXISTS (SELECT 1 FROM threads WHERE id = ANY($1::uuid[]) AND status = 'running')
        THEN 'A turn is running. Wait for it to finish or stop it, then move.'
      WHEN EXISTS (SELECT 1 FROM interaction_requests WHERE thread_id = ANY($1::uuid[]) AND status = 'pending')
        THEN 'A question or approval is waiting for an answer.'
      WHEN EXISTS (SELECT 1 FROM turn_steers WHERE thread_id = ANY($1::uuid[]) AND status IN ('pending','accepted'))
        THEN 'A message is still being delivered to the running turn.'
      WHEN EXISTS (SELECT 1 FROM thread_items WHERE thread_id = ANY($1::uuid[]) AND type = 'background_task'
        AND status = 'in_progress') THEN 'A background task is still running.'
      WHEN EXISTS (SELECT 1 FROM goals WHERE thread_id = ANY($1::uuid[]) AND status NOT IN ('achieved','cancelled'))
        THEN 'Finish or clear this thread''s goal before moving it.'
      WHEN EXISTS (SELECT 1 FROM agent_bus_calls WHERE (source_thread_id = ANY($1::uuid[]) OR target_thread_id = ANY($1::uuid[]))
        AND (status = 'requested' OR notify_status IN ('pending','steering'))) THEN 'Work with other agents is still in progress.'
      WHEN EXISTS (SELECT 1 FROM worker_commands WHERE thread_id = ANY($1::uuid[]) AND status IN ('pending','delivered')
        AND kind <> 'unloadThread') THEN 'The worker still has work for this thread. Try again in a moment.'
      ELSE '' END AS reason`,
      [family, owner],
    );

    return row?.reason ?? "";
  });
}

/** Final states of the given worker commands (missing ones are not listed). */
export function commandStatuses(ids: readonly string[]) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql.unsafe<{ status: string }>(
      `SELECT status FROM worker_commands WHERE id = ANY($1::uuid[])`,
      [ids],
    );

    return rows.map((r) => r.status);
  });
}

/** Commands of the family the old worker has not finished, including the unloads of the freeze. */
export function pendingThreadCommands(family: readonly string[]) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql.unsafe(
      `SELECT 1 FROM worker_commands WHERE thread_id = ANY($1::uuid[]) AND status IN ('pending','delivered') LIMIT 1`,
      [family],
    );

    return rows.length > 0;
  });
}

/** A path as the worker's file system compares it: case-insensitive on Windows and macOS, `\\` on Windows. */
export function canonicalPath(path: string, os: string) {
  const separated = os === "win32" ? path.replaceAll("/", "\\") : path;

  return os === "win32" || os === "darwin" ? separated.toLowerCase() : separated;
}

const sqlCanonical = (column: string) =>
  `CASE $4 WHEN 'win32' THEN lower(replace(${column}, '/', E'\\\\')) WHEN 'darwin' THEN lower(${column}) ELSE ${column} END`;

/** `path` is `root` or inside it, both canonical for the worker's system. */
const sqlWithin = (root: string) =>
  `(${sqlCanonical("$3")} = ${sqlCanonical(root)} OR left(${sqlCanonical("$3")}, length(${root}) + 1) IN
    (${sqlCanonical(root)} || '/', ${sqlCanonical(root)} || E'\\\\'))`;

/**
 * Whether a move is reading the checkout holding `path` (or inside it): Canopy's own file saves, deletions and branch
 * changes there wait for its decision, since the move carries the checkout as it was exported. `os` is the worker's.
 */
export function checkoutMoving(owner: string, workerId: string, path: string, os: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql.unsafe(
      `SELECT 1 FROM thread_transfers WHERE owner_user_id = $1::uuid AND state IN ('preparing','prepared')
        AND source_worker_id = $2::uuid AND ${sqlWithin("source_cwd")}
      UNION ALL
      SELECT 1 FROM computer_moves m JOIN threads t ON t.id = m.item_id AND t.owner_user_id = m.owner_user_id
      WHERE m.owner_user_id = $1::uuid AND m.role = 'source' AND m.state = 'preparing'
        AND (m.placement->>'nativeFiles')::boolean AND t.worker_id = $2::uuid AND t.cwd IS NOT NULL
        AND ${sqlWithin("t.cwd")}
      LIMIT 1`,
      [owner, workerId, path, os],
    );

    if (rows.length) return yield* Effect.fail(new Invalid(TRANSFER_BUSY));
  });
}

/** `path` is `root` or inside it, for either separator. */
/** `path` is `root` or inside it; both canonical (`canonicalPath`). */
const within = (path: string, root: string) =>
  path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);

const WAIT_MS = 30_000;

/**
 * Canopy's own writes into checkouts (file saves and deletions, branch switches and pulls) and the moves reading
 * them, in this gateway process. A write registers before it checks for a move and a move registers before it waits
 * for writes, so one of them always sees the other; `moving` (the database) covers moves after a restart.
 */
export class CheckoutWrites {
  readonly #writes = new Set<{ workerId: string; path: string }>();
  readonly #moves = new Set<{ workerId: string; root: string }>();

  constructor(
    private readonly moving: (workerId: string, path: string, os: string) => Promise<void>,
    private readonly osOf: (workerId: string) => string,
  ) {}

  /** Runs one write at `path` (a file or a checkout) unless a move reads a checkout it touches. */
  async admit<A>(workerId: string, at: string, work: () => Promise<A>): Promise<A> {
    const os = this.osOf(workerId);
    const path = canonicalPath(at, os);
    const write = { workerId, path };
    this.#writes.add(write);

    try {
      if ([...this.#moves].some((m) => m.workerId === workerId && (within(path, m.root) || within(m.root, path))))
        throw new Invalid(TRANSFER_BUSY);
      await this.moving(workerId, at, os);

      return await work();
    } finally {
      this.#writes.delete(write);
    }
  }

  /** A move reads `root` from now until the returned release: new writes wait, running ones finish first. */
  async block(workerId: string, at: string): Promise<() => void> {
    const root = canonicalPath(at, this.osOf(workerId));
    const move = { workerId, root };
    this.#moves.add(move);
    const release = () => void this.#moves.delete(move);
    const deadline = Date.now() + WAIT_MS;

    while ([...this.#writes].some((w) => w.workerId === workerId && (within(w.path, root) || within(root, w.path)))) {
      if (Date.now() > deadline) {
        release();
        throw new Invalid("Canopy is still saving files in this thread's folder. Try again in a moment.");
      }

      await Bun.sleep(100);
    }

    return release;
  }
}
