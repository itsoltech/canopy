import type { Database } from "bun:sqlite";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, type ThreadEvent } from "@canopy/contracts";
import { Effect } from "effect";
import type { JournalError, OpenTurn, TurnHarness } from "./journal.ts";

export function turnTracking(
  db: Database,
  attempt: <A>(operation: string, run: () => A) => Effect.Effect<A, JournalError>,
) {
  const insertTurn = db.query("INSERT OR IGNORE INTO open_turns (thread_id, turn_id) VALUES ($thread, $turn)");
  const insertStarted = db.query("INSERT OR IGNORE INTO started_turns (thread_id, turn_id) VALUES ($thread, $turn)");
  const selectStarted = db.query("SELECT 1 FROM started_turns WHERE thread_id = $thread AND turn_id = $turn");
  const deleteTurn = db.query("DELETE FROM open_turns WHERE thread_id = $thread AND turn_id = $turn");

  const selectTurns = db.query<{ thread_id: string; turn_id: string }, []>(
    "SELECT thread_id, turn_id FROM open_turns ORDER BY rowid",
  );

  const upsertItem = db.query(
    `INSERT INTO turn_items (thread_id, turn_id, item_id, item, done)
     SELECT $thread, $turn, $item_id, $item, $done WHERE EXISTS (SELECT 1 FROM open_turns WHERE thread_id = $thread AND turn_id = $turn)
     ON CONFLICT (thread_id, item_id) DO UPDATE SET item = excluded.item, done = max(turn_items.done, excluded.done)`,
  );

  const deleteItems = db.query("DELETE FROM turn_items WHERE thread_id = $thread AND turn_id = $turn");
  const deleteHarness = db.query("DELETE FROM turn_harness WHERE thread_id = $thread AND turn_id = $turn");

  const insertInterrupt = db.query(
    "INSERT OR IGNORE INTO turn_interrupts (thread_id, turn_id) VALUES ($thread, $turn)",
  );

  const deleteInterrupt = db.query("DELETE FROM turn_interrupts WHERE thread_id = $thread AND turn_id = $turn");

  const selectInterrupt = db.query<{ n: number }, { thread: string; turn: string }>(
    "SELECT count(*) AS n FROM turn_interrupts WHERE thread_id = $thread AND turn_id = $turn",
  );

  const trackTurn = (threadId: string, turnId: string, body: ThreadEvent["body"]) => {
    if (!turnId) return;

    if (body.case === "turnStarted") {
      insertTurn.run({ thread: threadId, turn: turnId });
      insertStarted.run({ thread: threadId, turn: turnId });
    }

    if (body.case === "turnFinished") {
      deleteTurn.run({ thread: threadId, turn: turnId });
      deleteItems.run({ thread: threadId, turn: turnId });
      deleteHarness.run({ thread: threadId, turn: turnId });
      deleteInterrupt.run({ thread: threadId, turn: turnId });
    }

    if (body.case === "itemStarted" || body.case === "itemCompleted") {
      const item = body.value.item;

      if (!item?.itemId || item.content.case === "backgroundTask") return;
      // A started event never reopens a finished item (like the gateway's reducer).
      const done = body.case === "itemCompleted" && item.status !== ItemStatus.IN_PROGRESS ? 1 : 0;
      upsertItem.run({ thread: threadId, turn: turnId, item_id: item.itemId, item: toBinary(ItemSchema, item), done });
    }
  };

  const selectHarness = db.query<
    {
      harness: "codex" | "claude" | "grok";
      transcript: string;
      session_id: string;
      start_offset: number;
      provider_turn: string;
    },
    { thread: string; turn: string }
  >(
    "SELECT harness, transcript, session_id, start_offset, provider_turn FROM turn_harness WHERE thread_id = $thread AND turn_id = $turn",
  );

  const selectItems = db.query<{ item: Uint8Array; done: number }, { thread: string; turn: string }>(
    "SELECT item, done FROM turn_items WHERE thread_id = $thread AND turn_id = $turn ORDER BY rowid",
  );

  const upsertHarness = db.query(
    `INSERT INTO turn_harness (thread_id, turn_id, harness, transcript, session_id, start_offset, provider_turn)
     VALUES ($thread, $turn, $harness, $transcript, $session, $offset, $provider_turn)
     ON CONFLICT (thread_id, turn_id) DO UPDATE SET harness = excluded.harness, transcript = excluded.transcript,
       session_id = excluded.session_id, start_offset = min(turn_harness.start_offset, excluded.start_offset),
       provider_turn = CASE WHEN excluded.provider_turn <> '' THEN excluded.provider_turn ELSE turn_harness.provider_turn END`,
  );

  return {
    trackTurn,
    wasInterrupted: (threadId: string, turnId: string) =>
      attempt("wasInterrupted", () => (selectInterrupt.get({ thread: threadId, turn: turnId })?.n ?? 0) > 0),
    hasStartedTurn: (threadId: string, turnId: string) =>
      attempt("hasStartedTurn", () => selectStarted.get({ thread: threadId, turn: turnId }) !== null),
    openTurns: Effect.fn("Journal.openTurns")(() =>
      attempt("openTurns", () =>
        selectTurns.all().map((r): OpenTurn => {
          const key = { thread: r.thread_id, turn: r.turn_id };
          const h = selectHarness.get(key);

          return {
            threadId: r.thread_id,
            turnId: r.turn_id,
            ...(h && {
              harness: {
                harness: h.harness,
                transcript: h.transcript,
                sessionId: h.session_id,
                offset: h.start_offset,
                providerTurn: h.provider_turn,
              },
            }),
            items: selectItems.all(key).map((i) => ({ item: fromBinary(ItemSchema, i.item), done: i.done === 1 })),
            interruptRequested: (selectInterrupt.get(key)?.n ?? 0) > 0,
          };
        }),
      ),
    ),
    noteInterrupt: Effect.fn("Journal.noteInterrupt")((threadId: string, turnId: string) =>
      attempt("noteInterrupt", () => {
        insertInterrupt.run({ thread: threadId, turn: turnId });
      }),
    ),
    noteHarness: Effect.fn("Journal.noteHarness")((threadId: string, turnId: string, harness: TurnHarness) =>
      attempt("noteHarness", () => {
        upsertHarness.run({
          thread: threadId,
          turn: turnId,
          harness: harness.harness,
          transcript: harness.transcript,
          session: harness.sessionId,
          offset: harness.offset,
          provider_turn: harness.providerTurn,
        });
      }),
    ),
  };
}
