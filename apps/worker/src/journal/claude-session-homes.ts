import type { Database } from "bun:sqlite";
import type { Effect } from "effect";
import type { JournalError } from "./journal.ts";

/** Session locations outlive turn completion, event ACKs and worker/runtime restarts. */
export function claudeSessionTracking(
  db: Database,
  attempt: <A>(operation: string, run: () => A) => Effect.Effect<A, JournalError>,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_session_homes (thread_id TEXT PRIMARY KEY, home TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS claude_session_history (
      thread_id TEXT NOT NULL, session_id TEXT NOT NULL, has_history INTEGER NOT NULL,
      PRIMARY KEY (thread_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS claude_import_homes (
      profile_id TEXT NOT NULL, session_id TEXT NOT NULL, home TEXT NOT NULL,
      PRIMARY KEY (profile_id, session_id)
    );
    INSERT OR IGNORE INTO claude_session_homes
      SELECT thread_id, transcript FROM turn_harness WHERE harness = 'claude';
    INSERT OR IGNORE INTO claude_session_history
      SELECT thread_id, session_id, 1 FROM turn_harness WHERE harness = 'claude';
  `);
  const home = db.query<{ home: string }, [string]>("SELECT home FROM claude_session_homes WHERE thread_id = ?");
  const bind = db.query("INSERT OR IGNORE INTO claude_session_homes VALUES (?, ?)");

  const history = db.query<{ has_history: number }, [string, string]>(
    "SELECT has_history FROM claude_session_history WHERE thread_id = ? AND session_id = ?",
  );

  // A shell-backed first turn is recorded in open_turns before Claude opens. It must not make that new session look
  // like an older session whose transcript went missing; completed or otherwise settled turns remain authoritative.
  const started = db.query(
    `SELECT 1 FROM started_turns AS s
     WHERE s.thread_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM open_turns AS o WHERE o.thread_id = s.thread_id AND o.turn_id = s.turn_id
       ) LIMIT 1`,
  );

  const remember = db.query(
    `INSERT INTO claude_session_history VALUES (?, ?, ?) ON CONFLICT(thread_id, session_id)
     DO UPDATE SET has_history = max(claude_session_history.has_history, excluded.has_history)`,
  );

  const imported = db.query<{ home: string }, [string, string]>(
    "SELECT home FROM claude_import_homes WHERE profile_id = ? AND session_id = ?",
  );

  const bindImport = db.query("INSERT OR IGNORE INTO claude_import_homes VALUES (?, ?, ?)");

  const boundHome = db.query(
    `SELECT 1 FROM claude_session_homes WHERE home = ?
     UNION ALL SELECT 1 FROM claude_import_homes WHERE home = ? LIMIT 1`,
  );

  const bindTx = db.transaction((threadId: string, proposed: string) => {
    bind.run(threadId, proposed);

    return home.get(threadId)!.home;
  });

  const importTx = db.transaction((profileId: string, sessionId: string, proposed: string) => {
    bindImport.run(profileId || "native", sessionId, proposed);

    return imported.get(profileId || "native", sessionId)!.home;
  });

  return {
    claudeSessionHome: (threadId: string) => attempt("claudeSessionHome", () => home.get(threadId)?.home),
    isClaudeSessionHomeBound: (path: string) =>
      attempt("isClaudeSessionHomeBound", () => boundHome.get(path, path) !== null),
    bindClaudeSessionHome: (threadId: string, proposed: string) =>
      attempt("bindClaudeSessionHome", () => bindTx(threadId, proposed)),
    hasClaudeSessionHistory: (threadId: string, sessionId: string) =>
      attempt("hasClaudeSessionHistory", () => {
        const row = history.get(threadId, sessionId);

        return row ? row.has_history === 1 : undefined;
      }),
    hasStartedClaudeThread: (threadId: string) =>
      attempt("hasStartedClaudeThread", () => started.get(threadId) !== null),
    rememberClaudeSession: (threadId: string, sessionId: string, empty = false) =>
      attempt("rememberClaudeSession", () => {
        remember.run(threadId, sessionId, empty ? 0 : 1);
      }),
    claudeImportedSessionHome: (profileId: string, sessionId: string) =>
      attempt("claudeImportedSessionHome", () => imported.get(profileId || "native", sessionId)?.home),
    bindClaudeImportedSessionHome: (profileId: string, sessionId: string, proposed: string) =>
      attempt("bindClaudeImportedSessionHome", () => importTx(profileId, sessionId, proposed)),
  };
}
