import type { Database } from "bun:sqlite";
import type { Effect } from "effect";
import type { JournalError } from "./journal.ts";

type Attempt = <A>(operation: string, run: () => A) => Effect.Effect<A, JournalError>;

/** Legacy gateways can request endless ingest drains. Retain those journals until a safe gateway answers. */
export function heldDelivery(db: Database, attempt: Attempt) {
  db.exec("CREATE TABLE IF NOT EXISTS held_delivery (thread_id TEXT PRIMARY KEY)");

  return {
    holdPending: () =>
      attempt(
        "holdPending",
        () => db.query("INSERT OR IGNORE INTO held_delivery SELECT DISTINCT thread_id FROM events").run().changes,
      ),
    heldThreads: () =>
      attempt("heldThreads", () =>
        db
          .query<{ thread_id: string }, []>(
            "SELECT thread_id FROM held_delivery WHERE EXISTS(SELECT 1 FROM events WHERE events.thread_id=held_delivery.thread_id)",
          )
          .all()
          .map((row) => row.thread_id),
      ),
    resumeDelivery: () => attempt("resumeDelivery", () => void db.exec("DELETE FROM held_delivery")),
  };
}
