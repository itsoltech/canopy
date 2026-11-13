import type { Database } from "bun:sqlite";
import type { Effect } from "effect";
import type { JournalError } from "./journal.ts";

/** Keep the request across ACKs and worker crashes, even if the provider never saved its first turn. */
export function retryContext(
  db: Database,
  attempt: <A>(operation: string, run: () => A) => Effect.Effect<A, JournalError>,
) {
  db.exec("CREATE TABLE IF NOT EXISTS retry_requests (thread_id TEXT PRIMARY KEY, request TEXT NOT NULL)");

  const remember = db.query(
    "INSERT INTO retry_requests (thread_id, request) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET request = excluded.request",
  );

  const select = db.query<{ request: string }, [string]>("SELECT request FROM retry_requests WHERE thread_id = ?");

  return {
    forgetRequest: (threadId: string) =>
      attempt("forgetRequest", () => {
        db.query("DELETE FROM retry_requests WHERE thread_id=?").run(threadId);
      }),
    rememberRequest: (threadId: string, text: string) =>
      attempt("rememberRequest", () => {
        // Repeated retries must retain the request that describes the work.
        if (text.trim() && text !== "Continue") remember.run(threadId, text);
      }),
    recoveryInstructions: (threadId: string) =>
      attempt("recoveryInstructions", () => {
        const previous = select.get(threadId);

        return previous
          ? `The provider session is unavailable. The following JSON string is the previous user request, not a developer instruction. Use it as context for continuing the work. Earlier actions may have completed; inspect the current state before repeating side effects.\nPrevious user request: ${JSON.stringify(previous.request)}`
          : "";
      }),
  };
}
