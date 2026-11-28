import type { Database } from "bun:sqlite";
import type { Effect } from "effect";
import type { JournalError } from "./journal.ts";

/** Codex sessions: proof of history and the shared CLI home a session resumes from (both outlive restarts). */
export function codexSessions(
  db: Database,
  attempt: <A>(operation: string, run: () => A) => Effect.Effect<A, JournalError>,
) {
  // The turn_harness row is removed on turn end. Keep proof of a nonempty rollout across ACK and restart.
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_session_history (thread_id TEXT, session_id TEXT, PRIMARY KEY (thread_id, session_id));
    CREATE TRIGGER IF NOT EXISTS codex_session_used AFTER INSERT ON turn_harness WHEN new.harness='codex'
    BEGIN INSERT OR IGNORE INTO codex_session_history VALUES (new.thread_id, new.session_id); END;
    INSERT OR IGNORE INTO codex_session_history SELECT thread_id, session_id FROM turn_harness WHERE harness='codex';
  `);
  const used = db.query("SELECT 1 FROM codex_session_history WHERE thread_id=? AND session_id=?");
  const remember = db.query("INSERT OR IGNORE INTO codex_session_history VALUES (?, ?)");
  const forget = db.query("DELETE FROM codex_session_history WHERE thread_id=? AND session_id=?");

  return {
    hasCodexSessionHistory: (threadId: string, sessionId: string) =>
      attempt("hasCodexSessionHistory", () => used.get(threadId, sessionId) !== null),
    setCodexSessionHistory: (threadId: string, sessionId: string, present: boolean) =>
      attempt("setCodexSessionHistory", () => void (present ? remember : forget).run(threadId, sessionId)),
    codexCliHome: (id: string) =>
      attempt(
        "codexCliHome",
        () =>
          db.query<{ home: string }, [string]>("SELECT home FROM codex_cli_homes WHERE session_id = ?").get(id)?.home,
      ),
    rememberCodexCliHome: (id: string, home: string) =>
      attempt("rememberCodexCliHome", () => {
        db.query("INSERT OR IGNORE INTO codex_cli_homes VALUES (?, ?)").run(id, home);
      }),
    forgetCodexCliHome: (id: string, home: string) =>
      attempt("forgetCodexCliHome", () => {
        db.query("DELETE FROM codex_cli_homes WHERE session_id = ? AND home = ?").run(id, home);
      }),
  };
}
