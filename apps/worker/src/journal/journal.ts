import { Database } from "bun:sqlite";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import {
  CommandResultSchema,
  ItemSchema,
  ItemStatus,
  ThreadEventSchema,
  type CommandResult,
  type Item,
  type ThreadEvent,
} from "@canopy/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import { turnTracking } from "./turn-tracking.ts";
import { shellTracking } from "./shell-inputs.ts";
import { retryContext } from "./retry-context.ts";
import { heldDelivery } from "./held-delivery.ts";
import { commandTracking } from "./commands.ts";
import { secretEventRedactor } from "../runtime/thread-secrets.ts";
import { journalStatistics, type JournalStatistics } from "./statistics.ts";
import { workerDiagnostics } from "../diagnostics/worker.ts";

/**
 * Local durable outbox of the worker (docs/durability.md, 3.1).
 *
 * - Every thread event is written here before it is sent; the gateway acks by journal_seq after
 *   its own commit, and only then the event is deleted. Nothing is lost across crashes or reconnects.
 * - journal_seq grows per thread and never goes back, also after all events were acked or the
 *   process restarted (kept in thread_seq).
 * - journal_id identifies this database; a reinstalled worker gets a new one, so the gateway knows
 *   old cursors do not apply and deduplicates the resend by event_id.
 * - Results of processed commands are remembered so a redelivered command is answered, not re-run.
 * - Background tasks that started but did not finish are tracked in the same transaction as their events,
 *   so after a crash the worker can close them as interrupted (their processes died with it). Turns likewise:
 *   a turn whose start is journaled and whose end is not died with the previous process.
 * - For every open turn the journal also keeps where its harness writes its own record (turn_harness: the Codex
 *   rollout, the Claude session transcript, the offset the turn starts at) and which of its items are open or done
 *   (turn_items). Reconciliation (runtime/reconcile.ts) reads the harness record and journals only what is missing.
 *
 * SQLite in WAL mode with synchronous=FULL: a committed append survives power loss.
 */

export class JournalError extends Schema.TaggedError<JournalError>()("JournalError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export type ThreadEventInit = Omit<MessageInitShape<typeof ThreadEventSchema>, "journalSeq" | "eventId" | "threadId">;

export interface ThreadCursor {
  readonly threadId: string;
  readonly lastSeq: bigint;
}

export interface OpenBackgroundTask {
  readonly threadId: string;
  /** Last started state of the background_task item. */
  readonly item: Item;
}

/** Where the harness of a turn keeps its own record of it (docs/durability.md, "Rekoncyliacja z transkryptu harnessu"). */
export interface TurnHarness {
  readonly harness: "codex" | "claude" | "grok";
  /** Codex: the rollout file (Thread.path); Claude: the config dir (CLAUDE_CONFIG_DIR) holding projects/<cwd>/<session>.jsonl. */
  readonly transcript: string;
  /** Codex thread id or Claude session id. */
  readonly sessionId: string;
  /** Size of the transcript when the turn started: its record comes after this. */
  readonly offset: number;
  /** Codex turn id, once known (empty for Claude). */
  readonly providerTurn: string;
}

export interface OpenTurn {
  readonly threadId: string;
  readonly turnId: string;
  /** Absent when the turn was started by a process that did not record it. */
  readonly harness?: TurnHarness;
  /** The turn's items as journaled: last state, and whether they finished. Background tasks are not here. */
  readonly items: ReadonlyArray<{ readonly item: Item; readonly done: boolean }>;
  /**
   * The platform asked to interrupt the turn (InterruptTurn). Without that, an interruption the harness recorded was
   * not the user's (e.g. Codex aborts the turn when its worker dies and its input closes).
   */
  readonly interruptRequested: boolean;
}

export class Journal extends Context.Service<
  Journal,
  {
    readonly journalId: string;
    rememberRequest: ReturnType<typeof retryContext>["rememberRequest"];
    recoveryInstructions: ReturnType<typeof retryContext>["recoveryInstructions"];
    holdPending: ReturnType<typeof heldDelivery>["holdPending"];
    heldThreads: ReturnType<typeof heldDelivery>["heldThreads"];
    resumeDelivery: ReturnType<typeof heldDelivery>["resumeDelivery"];
    readonly statistics?: () => JournalStatistics;
    beginShellInput: ReturnType<typeof shellTracking>["beginShellInput"];
    shellInput: ReturnType<typeof shellTracking>["shellInput"];
    shellPid: ReturnType<typeof shellTracking>["shellPid"];
    finishShellInput: ReturnType<typeof shellTracking>["finishShellInput"];
    openShellInputs: ReturnType<typeof shellTracking>["openShellInputs"];
    /** Assigns journal_seq and event_id (UUIDv7) and stores the event durably. */
    append(threadId: string, event: ThreadEventInit): Effect.Effect<ThreadEvent, JournalError>;
    /** Atomically accepts a bot command and journals its turn start before any harness effect. */
    admitBotTurn(
      commandId: string,
      botId: string,
      turnId: string,
    ): Effect.Effect<ThreadEvent | undefined, JournalError>;
    /** Gateway persisted everything up to ackSeq: drop it. Returns the number of removed events. */
    ack(threadId: string, ackSeq: bigint): Effect.Effect<number, JournalError>;
    /** Threads with unacked events and their last journal_seq (Hello.threads). */
    cursors(): Effect.Effect<ReadonlyArray<ThreadCursor>, JournalError>;
    /**
     * Events to (re)send after Welcome: everything above the persisted cursor per thread, oldest first.
     * Events at or below a persisted cursor are dropped on the way.
     */
    pending(persisted: ReadonlyMap<string, bigint>): Effect.Effect<ReadonlyArray<ThreadEvent>, JournalError>;
    rememberCommand(result: MessageInitShape<typeof CommandResultSchema>): Effect.Effect<void, JournalError>;
    commandResult(commandId: string): Effect.Effect<CommandResult | undefined, JournalError>;
    /** Forget command results older than maxAgeMs (redelivery happens within minutes, not days). */
    purgeCommands(maxAgeMs: number): Effect.Effect<number, JournalError>;
    /** Background tasks whose start is journaled and whose end is not (e.g. the worker crashed meanwhile). */
    openBackgroundTasks(): Effect.Effect<ReadonlyArray<OpenBackgroundTask>, JournalError>;
    /** Before killing any provider: terminal task events in this process belong to the worker shutdown. Returns the open count. */
    beginShutdown(): Effect.Effect<number, JournalError>;
    /** Turns whose turn_started is journaled and whose turn_finished is not, with their harness record and items. */
    openTurns(): Effect.Effect<ReadonlyArray<OpenTurn>, JournalError>;
    /** Durable admission receipt, retained after turn end and transcript ACK. */
    hasStartedTurn(threadId: string, turnId: string): Effect.Effect<boolean, JournalError>;
    wasInterrupted(threadId: string, turnId: string): Effect.Effect<boolean, JournalError>;
    /** Records (or updates) where the turn's harness keeps its record; dropped with the turn's end. */
    noteHarness(threadId: string, turnId: string, harness: TurnHarness): Effect.Effect<void, JournalError>;
    /** The platform asked to interrupt the turn (kept until its end). */
    noteInterrupt(threadId: string, turnId: string): Effect.Effect<void, JournalError>;
  }
>()("canopy/worker/Journal") {
  /** Journal backed by a SQLite file (created if missing). Closed when the scope ends. */
  static readonly layer = (path: string, diagnostics = false) =>
    Layer.effect(
      Journal,
      Effect.acquireRelease(
        Effect.try({ try: () => open(path), catch: (cause) => new JournalError({ operation: "open", cause }) }),
        (db) => Effect.sync(() => db.close()),
      ).pipe(Effect.map((db) => makeJournal(db, diagnostics))),
    );
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS thread_seq (thread_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    thread_id   TEXT NOT NULL,
    journal_seq INTEGER NOT NULL,
    event_id    TEXT NOT NULL UNIQUE,
    payload     BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (thread_id, journal_seq)
  );
  CREATE TABLE IF NOT EXISTS processed_commands (
    command_id   TEXT PRIMARY KEY,
    result       BLOB NOT NULL,
    processed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS processed_commands_age ON processed_commands (processed_at);
  CREATE TABLE IF NOT EXISTS background_tasks (
    thread_id TEXT NOT NULL,
    item_id   TEXT NOT NULL,
    item      BLOB NOT NULL,
    PRIMARY KEY (thread_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS open_turns (
    thread_id TEXT NOT NULL,
    turn_id   TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  );
  CREATE TABLE IF NOT EXISTS started_turns (
    thread_id TEXT NOT NULL,
    turn_id   TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  );
  INSERT OR IGNORE INTO started_turns SELECT thread_id, turn_id FROM open_turns;
  CREATE TABLE IF NOT EXISTS turn_harness (
    thread_id     TEXT NOT NULL,
    turn_id       TEXT NOT NULL,
    harness       TEXT NOT NULL,
    transcript    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    start_offset  INTEGER NOT NULL,
    provider_turn TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  );
  CREATE TABLE IF NOT EXISTS turn_interrupts (
    thread_id TEXT NOT NULL,
    turn_id   TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  );
  CREATE TABLE IF NOT EXISTS turn_items (
    thread_id TEXT NOT NULL,
    turn_id   TEXT NOT NULL,
    item_id   TEXT NOT NULL,
    item      BLOB NOT NULL,
    done      INTEGER NOT NULL,
    PRIMARY KEY (thread_id, item_id)
  );
`;

function open(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('journal_id', $id)").run({ id: Bun.randomUUIDv7() });

  return db;
}

function botAdmission(db: Database, append: (botId: string, event: ThreadEventInit) => ThreadEvent) {
  const select = db.query("SELECT command_id FROM processed_commands WHERE command_id = ?");
  const interrupted = db.query("SELECT turn_id FROM turn_interrupts WHERE thread_id = ? AND turn_id = ?");
  const insert = db.query("INSERT INTO processed_commands (command_id, result, processed_at) VALUES (?, ?, ?)");

  return db.transaction((commandId: string, botId: string, turnId: string) => {
    if (select.get(commandId)) return undefined;

    // Cancellation can overtake a replayed run command after reconnecting.
    const event = interrupted.get(botId, turnId)
      ? undefined
      : append(botId, { turnId, body: { case: "turnStarted", value: {} } });

    insert.run(
      commandId,
      toBinary(CommandResultSchema, create(CommandResultSchema, { commandId, ok: true })),
      Date.now(),
    );

    return event;
  });
}

function makeJournal(db: Database, diagnostics: boolean): Journal["Service"] {
  const redact = secretEventRedactor();
  let shuttingDown = false;

  const attempt = <A>(operation: string, run: () => A) =>
    Effect.try({ try: run, catch: (cause) => new JournalError({ operation, cause }) });

  const journalId = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'journal_id'").get()!.value;

  const nextSeq = db.query<{ last_seq: number }, { thread: string }>(
    `INSERT INTO thread_seq (thread_id, last_seq) VALUES ($thread, 1)
     ON CONFLICT (thread_id) DO UPDATE SET last_seq = last_seq + 1
     RETURNING last_seq`,
  );

  const insertEvent = db.query(
    "INSERT INTO events (thread_id, journal_seq, event_id, payload, created_at) VALUES ($thread, $seq, $id, $payload, $at)",
  );

  const { trackBackground, selectBackground } = backgroundTracking(db);

  const turns = turnTracking(db, attempt);

  const appendTx = db.transaction((threadId: string, event: ThreadEventInit) => {
    const seq = BigInt(nextSeq.get({ thread: threadId })!.last_seq);

    const { $typeName: _, ...fields } = event;

    const init: MessageInitShape<typeof ThreadEventSchema> = {
      ...fields,
      threadId,
      journalSeq: seq,
      eventId: Bun.randomUUIDv7(),
      occurredAt: event.occurredAt ?? timestampNow(),
    };

    const full = create(ThreadEventSchema, init);

    // Providers can report stopped/failed (or even a successful exit) while their runtime is being torn down.
    // Normalize BEFORE the first durable end, not in publish() or the later orphan sweep: the gateway's first
    // end wins and may already have queued the agent's note. This covers Claude and Codex alike.
    if (shuttingDown && full.body.case === "itemCompleted") {
      const item = full.body.value.item;

      if (item?.content.case === "backgroundTask" && item.status !== ItemStatus.IN_PROGRESS) {
        item.status = ItemStatus.INTERRUPTED;
        item.content.value.stopReason = "worker_shutdown";
        item.content.value.endedAt ??= full.occurredAt;
      }
    }

    insertEvent.run({
      thread: threadId,
      seq: Number(seq),
      id: full.eventId,
      payload: toBinary(ThreadEventSchema, full),
      at: Date.now(),
    });
    trackBackground(threadId, full.body);
    turns.trackTurn(threadId, full.turnId, full.body);

    return full;
  });

  const deleteUpTo = db.query("DELETE FROM events WHERE thread_id = $thread AND journal_seq <= $seq");

  const cursorRows = db.query<{ thread_id: string; last_seq: number }, []>(
    "SELECT thread_id, MAX(journal_seq) AS last_seq FROM events GROUP BY thread_id ORDER BY thread_id",
  );

  const threadsWithEvents = db.query<{ thread_id: string }, []>("SELECT DISTINCT thread_id FROM events");

  const eventsAfter = db.query<{ payload: Uint8Array }, { thread: string; seq: number }>(
    "SELECT payload FROM events WHERE thread_id = $thread AND journal_seq > $seq ORDER BY journal_seq",
  );

  const pendingTx = db.transaction((persisted: ReadonlyMap<string, bigint>) => {
    const out: ThreadEvent[] = [];

    for (const { thread_id: thread } of threadsWithEvents.all()) {
      const cursor = Number(persisted.get(thread) ?? 0n);

      if (cursor > 0) deleteUpTo.run({ thread, seq: cursor });

      for (const row of eventsAfter.all({ thread, seq: cursor })) out.push(fromBinary(ThreadEventSchema, row.payload));
    }

    return out;
  });

  const admit = botAdmission(db, appendTx);

  return Journal.of({
    ...commandTracking(db, attempt),
    hasStartedTurn: turns.hasStartedTurn,
    wasInterrupted: turns.wasInterrupted,
    ...retryContext(db, attempt),
    ...heldDelivery(db, attempt),
    ...(diagnostics && { statistics: journalStatistics(db) }),
    ...shellTracking(db, attempt, (threadId, event) => appendTx(threadId, redact(threadId, event))),
    journalId,
    admitBotTurn: (commandId, botId, turnId) => attempt("admitBotTurn", () => admit(commandId, botId, turnId)),
    append: Effect.fn("Journal.append")((threadId: string, event: ThreadEventInit) =>
      attempt("append", () => measuredAppend(appendTx(threadId, redact(threadId, event)))),
    ),
    ack: Effect.fn("Journal.ack")((threadId: string, ackSeq: bigint) =>
      attempt("ack", () => deleteUpTo.run({ thread: threadId, seq: Number(ackSeq) }).changes),
    ),
    cursors: Effect.fn("Journal.cursors")(() =>
      attempt("cursors", () => cursorRows.all().map((r) => ({ threadId: r.thread_id, lastSeq: BigInt(r.last_seq) }))),
    ),
    pending: Effect.fn("Journal.pending")((persisted: ReadonlyMap<string, bigint>) =>
      attempt("pending", () => pendingTx(persisted)),
    ),
    openBackgroundTasks: Effect.fn("Journal.openBackgroundTasks")(() =>
      attempt("openBackgroundTasks", () =>
        selectBackground.all().map((r) => ({ threadId: r.thread_id, item: fromBinary(ItemSchema, r.item) })),
      ),
    ),
    beginShutdown: Effect.fn("Journal.beginShutdown")(() =>
      attempt("beginShutdown", () => {
        shuttingDown = true;

        return selectBackground.all().length;
      }),
    ),
    openTurns: turns.openTurns,
    noteInterrupt: turns.noteInterrupt,
    noteHarness: turns.noteHarness,
  });
}

function measuredAppend(value: ThreadEvent) {
  try {
    workerDiagnostics.turns.event(value);
  } catch {
    /* Diagnostics cannot fail an already durable append. */
  }

  return value;
}

function backgroundTracking(db: Database) {
  const upsertBackground = db.query(
    `INSERT INTO background_tasks (thread_id, item_id, item) VALUES ($thread, $item_id, $item)
     ON CONFLICT (thread_id, item_id) DO UPDATE SET item = excluded.item`,
  );

  const deleteBackground = db.query("DELETE FROM background_tasks WHERE thread_id = $thread AND item_id = $item_id");

  const selectBackground = db.query<{ thread_id: string; item: Uint8Array }, []>(
    "SELECT thread_id, item FROM background_tasks ORDER BY rowid",
  );

  const trackBackground = (threadId: string, body: ThreadEvent["body"]) => {
    if (body.case !== "itemStarted" && body.case !== "itemCompleted") return;
    const item = body.value.item;

    if (item?.content.case !== "backgroundTask") return;

    if (item.status === ItemStatus.IN_PROGRESS) {
      upsertBackground.run({ thread: threadId, item_id: item.itemId, item: toBinary(ItemSchema, item) });
    } else {
      deleteBackground.run({ thread: threadId, item_id: item.itemId });
    }
  };

  return { trackBackground, selectBackground };
}
