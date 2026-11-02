import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import type { SteerRow } from "./steers.ts";
import { Invalid, NotFound, type TurnRow } from "./store.ts";

/**
 * The queue a user manages (docs/ui-api.md, "Kolejka"): queued turns waiting behind the running one.
 *
 * The queue's order is the turns' ordinal (GatewayStore.nextTurn starts the lowest). Every change here and the
 * scheduler's start of the head (`whileHead`) lock the thread row first, so they run one after another: a turn
 * the scheduler already started (its StartTurn is in the outbox) cannot be moved, edited, deleted or steered
 * (QueueConflict), and the scheduler starts only the head it read, with the input it read (`revision`).
 */

/** The turn already started or left the queue, or another device changed it first: the client has the news live. */
export class QueueConflict extends Error {
  override readonly name = "QueueConflict";
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid | QueueConflict>;

type LockedTurn = TurnRow & { revision: number; withdrawn: string | null; author_user_id: string | null; started: boolean };

/** The turn has a live command (StartTurn): the scheduler took it, whatever its status says yet. */
const DISPATCHED = `EXISTS (SELECT 1 FROM worker_commands c WHERE c.turn_id = u.id AND c.status IN ('pending', 'delivered', 'completed'))`;

export class QueueStore extends Context.Service<
  QueueStore,
  {
    /**
     * The listed queued turns take, in the listed order, the places (ordinals) they hold together; turns of the
     * queue the client does not know yet keep theirs. Returns the listed turns in their new order.
     */
    reorder(input: { threadId: string; ownerUserId: string; turnIds: readonly string[] }): Fx<TurnRow[]>;
    /** A user's queued message as the scheduler would read it now (no lock; `edit` checks the revision). */
    queued(input: { turnId: string; ownerUserId: string }): Fx<TurnRow>;
    /**
     * A user's queued message gets a new input (composed by the caller like a sent message: its attachments note,
     * its mentions; overrides stay); `expectedRevision` as read.
     */
    edit(input: { turnId: string; ownerUserId: string; input: TurnRow["input"]; expectedRevision: number }): Fx<TurnRow>;
    /** A user's queued message leaves the queue (cancelled, withdrawn = deleted). */
    remove(input: { turnId: string; ownerUserId: string }): Fx<TurnRow>;
    /** Undoes `remove`: back in the queue at its place. */
    restore(input: { turnId: string; ownerUserId: string }): Fx<TurnRow>;
    /**
     * A user's queued message becomes a steer into the running turn (pending; the caller sends SteerTurn) and
     * leaves the queue (withdrawn = steered) in one transaction. SteerStore.queue brings the turn back when the
     * steer cannot join. Without a running turn it stays queued (QueueConflict).
     */
    steer(input: { turnId: string; ownerUserId: string }): Fx<{ steer: SteerRow; turn: TurnRow }>;
    /**
     * Runs `start` (record the settings, put StartTurn in the outbox) only while the turn is still the queue's
     * head with the revision the scheduler read; else nothing (undefined) and the scheduler reads the queue again.
     */
    whileHead<A, E, R>(input: { threadId: string; turnId: string; revision: number }, start: Effect.Effect<A, E, R>): Effect.Effect<A | undefined, E | SqlError.SqlError, R>;
  }
>()("open-agents/gateway/QueueStore") {
  static readonly layer = Layer.effect(
    QueueStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const lockThread = (threadId: string, ownerUserId: string) =>
        sql<{ id: string }>`SELECT id FROM threads WHERE id = ${threadId}::uuid AND owner_user_id = ${ownerUserId}::uuid AND deleted_at IS NULL AND archived_at IS NULL FOR UPDATE`.pipe(
          Effect.flatMap((rows) => (rows[0] ? Effect.void : Effect.fail(new NotFound("thread not found")))),
        );

      /** The turns with their sources (as GatewayStore.turnsOf), in the given order. */
      const read = (ids: readonly string[]) =>
        sql<TurnRow>`
          SELECT u.*, s.*
            FROM turns u LEFT JOIN turn_sources s ON s.turn_id = u.id WHERE u.id = ANY(${`{${ids.join(",")}}`}::uuid[])`.pipe(
          Effect.map((rows) => ids.flatMap((id) => rows.filter((r) => r.id === id))),
        );
      const readOne = (id: string) => read([id]).pipe(Effect.map((rows) => rows[0]!));

      /** Locks the turn's thread, then the turn (only the owner's turns are found). */
      const lockTurn = (turnId: string, ownerUserId: string) =>
        Effect.gen(function* () {
          const owner = yield* sql<{ thread_id: string }>`
            SELECT u.thread_id FROM turns u JOIN threads t ON t.id = u.thread_id
             WHERE u.id = ${turnId}::uuid AND t.owner_user_id = ${ownerUserId}::uuid`;
          if (!owner[0]) return yield* Effect.fail(new NotFound("turn not found"));
          yield* lockThread(owner[0].thread_id, ownerUserId);
          const rows = yield* sql.unsafe<LockedTurn>(`SELECT u.*, ${DISPATCHED} AS started FROM turns u WHERE u.id = $1::uuid FOR UPDATE`, [turnId]);
          return rows[0]!;
        });

      const stillQueued = (turn: LockedTurn): Effect.Effect<void, QueueConflict> =>
        turn.status === "running" || (turn.status === "queued" && turn.started)
          ? Effect.fail(new QueueConflict("this message already started running"))
          : turn.status !== "queued"
            ? Effect.fail(new QueueConflict(turn.withdrawn ? "this message is no longer in the queue" : `this message is no longer queued (${turn.status})`))
            : Effect.void;

      /** A queued message of the user (agents' and schedules' turns are only reordered). */
      const lockUserMessage = (turnId: string, ownerUserId: string) =>
        Effect.gen(function* () {
          const turn = yield* lockTurn(turnId, ownerUserId);
          yield* stillQueued(turn);
          if (turn.trigger !== "user") return yield* Effect.fail(new Invalid("only your own messages can be changed in the queue"));
          return turn;
        });

      const store: QueueStore["Service"] = {
        reorder: ({ threadId, ownerUserId, turnIds }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              if (new Set(turnIds).size !== turnIds.length) return yield* Effect.fail(new Invalid("a turn is listed twice"));
              yield* lockThread(threadId, ownerUserId);
              if (turnIds.length === 0) return [];
              const ids = `{${turnIds.join(",")}}`;
              const rows = yield* sql.unsafe<LockedTurn>(
                `SELECT u.*, ${DISPATCHED} AS started FROM turns u WHERE u.thread_id = $1::uuid AND u.id = ANY($2::uuid[]) FOR UPDATE`,
                [threadId, ids],
              );
              if (rows.length !== turnIds.length) return yield* Effect.fail(new NotFound("turn not found"));
              for (const row of rows) yield* stillQueued(row);
              const slots = rows.map((r) => r.ordinal).sort((a, b) => a - b);
              // (thread_id, ordinal) is unique per statement: step aside first, then take the new places.
              yield* sql`UPDATE turns SET ordinal = -ordinal WHERE id = ANY(${ids}::uuid[])`;
              yield* sql`
                UPDATE turns u SET ordinal = v.ordinal
                  FROM unnest(${ids}::uuid[], ${`{${slots.join(",")}}`}::int[]) AS v(id, ordinal)
                 WHERE u.id = v.id`;
              return yield* read(turnIds);
            }),
          ),

        queued: ({ turnId, ownerUserId }) =>
          sql<TurnRow>`
            SELECT u.* FROM turns u JOIN threads t ON t.id = u.thread_id
             WHERE u.id = ${turnId}::uuid AND t.owner_user_id = ${ownerUserId}::uuid`.pipe(
            Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("turn not found")))),
          ),

        edit: ({ turnId, ownerUserId, input, expectedRevision }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const turn = yield* lockUserMessage(turnId, ownerUserId);
              if (turn.revision !== expectedRevision) return yield* Effect.fail(new QueueConflict("this message was changed elsewhere; edit the new version"));
              const carries = (turn.input.attachments ?? []).length > 0 || (input.quotes ?? []).length > 0;
              if (!(input.message ?? input.text ?? "").trim() && !carries) return yield* Effect.fail(new Invalid("message is empty"));
              // The files stay the turn's (they are bound to it).
              const next = { ...input, ...(turn.input.attachments && { attachments: turn.input.attachments }) };
              yield* sql`UPDATE turns SET input = ${JSON.stringify(next)}::jsonb, revision = revision + 1 WHERE id = ${turnId}::uuid`;
              return yield* readOne(turnId);
            }),
          ),

        remove: ({ turnId, ownerUserId }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* lockUserMessage(turnId, ownerUserId);
              yield* sql`UPDATE turns SET status = 'cancelled', withdrawn = 'deleted', completed_at = now() WHERE id = ${turnId}::uuid`;
              return yield* readOne(turnId);
            }),
          ),

        restore: ({ turnId, ownerUserId }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const turn = yield* lockTurn(turnId, ownerUserId);
              if (turn.status === "queued" && !turn.withdrawn) return yield* readOne(turnId); // restored already
              if (turn.withdrawn !== "deleted") return yield* Effect.fail(new QueueConflict("this message was not deleted from the queue"));
              yield* sql`UPDATE turns SET status = 'queued', withdrawn = NULL, completed_at = NULL WHERE id = ${turnId}::uuid`;
              return yield* readOne(turnId);
            }),
          ),

        steer: ({ turnId, ownerUserId }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const turn = yield* lockUserMessage(turnId, ownerUserId);
              if ((turn.input.attachments ?? []).length > 0) return yield* Effect.fail(new Invalid("a message with attachments runs as its own turn"));
              const running = yield* sql<{ id: string; worker_id: string | null }>`
                SELECT u.id, t.worker_id FROM turns u JOIN threads t ON t.id = u.thread_id
                 WHERE u.thread_id = ${turn.thread_id}::uuid AND u.status = 'running'`;
              if (!running[0]?.worker_id) return yield* Effect.fail(new QueueConflict("no turn is running; the message stays in the queue"));
              const id = Bun.randomUUIDv7();
              yield* sql`
                INSERT INTO turn_steers (id, thread_id, turn_id, input, author_user_id, model, effort, permission_mode, from_turn_id)
                VALUES (${id}::uuid, ${turn.thread_id}::uuid, ${running[0].id}::uuid, ${JSON.stringify(turn.input)}::jsonb,
                        ${turn.author_user_id}::uuid, ${turn.model ?? ""}, ${turn.effort ?? ""}, ${turn.permission_mode ?? ""}, ${turnId}::uuid)`;
              yield* sql`UPDATE turns SET status = 'cancelled', withdrawn = 'steered', completed_at = now() WHERE id = ${turnId}::uuid`;
              const steer = (yield* sql<SteerRow>`SELECT * FROM turn_steers WHERE id = ${id}::uuid`)[0]!;
              return { steer, turn: yield* readOne(turnId) };
            }),
          ),

        whileHead: ({ threadId, turnId, revision }, start) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT id FROM threads WHERE id = ${threadId}::uuid FOR UPDATE`;
              const head = yield* sql.unsafe<{ id: string }>(
                `SELECT u.id FROM turns u
                  WHERE u.id = $1::uuid AND u.status = 'queued' AND u.revision = $2 AND NOT ${DISPATCHED}
                    AND NOT EXISTS (SELECT 1 FROM turns q WHERE q.thread_id = u.thread_id AND q.status = 'queued' AND q.ordinal < u.ordinal
                                      AND NOT EXISTS (SELECT 1 FROM worker_commands c WHERE c.turn_id = q.id AND c.status IN ('pending', 'delivered', 'completed')))`,
                [turnId, revision],
              );
              if (!head[0]) return undefined;
              return yield* start;
            }),
          ),
      };
      return QueueStore.of(store);
    }),
  );
}
