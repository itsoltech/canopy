import type { Database } from "bun:sqlite";
import type { Effect } from "effect";
import type { JournalError } from "./journal.ts";

/** Stores only turn and native session IDs, before any project secret is materialized. */
export function projectSecretHistory(
  db: Database,
  attempt: <A>(operation: string, run: () => A) => Effect.Effect<A, JournalError>,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_secret_turns (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  );
  CREATE INDEX IF NOT EXISTS project_secret_native_session ON project_secret_turns (native_session_id)`);

  const noteProjectSecretTurn = db.query(
    `INSERT INTO project_secret_turns (thread_id, turn_id, native_session_id)
     SELECT $thread, $turn, coalesce((
       SELECT session_id FROM turn_harness WHERE thread_id = $thread AND turn_id = $turn
     ), '') FROM open_turns WHERE thread_id = $thread AND turn_id = $turn
       AND NOT EXISTS (SELECT 1 FROM turn_interrupts WHERE thread_id = $thread AND turn_id = $turn)
     ON CONFLICT (thread_id, turn_id) DO UPDATE SET native_session_id = coalesce(
       nullif(project_secret_turns.native_session_id, ''), excluded.native_session_id
     )`,
  );

  const selectProjectSecretTurn = db.query(
    "SELECT 1 FROM project_secret_turns WHERE thread_id = $thread AND turn_id = $turn",
  );

  const selectProjectSecretHistory = db.query("SELECT 1 FROM project_secret_turns WHERE thread_id = $thread LIMIT 1");

  const selectProjectSecretNativeHistory = db.query(
    `SELECT 1 FROM project_secret_turns
     WHERE native_session_id = $session OR (thread_id = $thread AND native_session_id = '') LIMIT 1`,
  );

  const hasProjectSecretTurn = (threadId: string, turnId: string) =>
    selectProjectSecretTurn.get({ thread: threadId, turn: turnId }) !== null;

  return {
    isProjectSecretTurn: hasProjectSecretTurn,
    markProjectSecretTurn: (threadId: string, turnId: string) =>
      attempt(
        "markProjectSecretTurn",
        () => noteProjectSecretTurn.run({ thread: threadId, turn: turnId }).changes === 1,
      ),
    hasProjectSecretTurn: (threadId: string, turnId: string) =>
      attempt("hasProjectSecretTurn", () => hasProjectSecretTurn(threadId, turnId)),
    hasProjectSecretHistory: (threadId: string, nativeSessionId?: string) =>
      attempt("hasProjectSecretHistory", () =>
        nativeSessionId
          ? selectProjectSecretNativeHistory.get({ thread: threadId, session: nativeSessionId }) !== null
          : selectProjectSecretHistory.get({ thread: threadId }) !== null,
      ),
  };
}
