import type { Database } from "bun:sqlite";
import type { Effect } from "effect";
import type { JournalError } from "./journal.ts";

/** Retained after event ACKs so connector change notes survive worker restarts. */
export function connectorCatalog(
  db: Database,
  attempt: <A>(operation: string, run: () => A) => Effect.Effect<A, JournalError>,
) {
  db.exec("CREATE TABLE IF NOT EXISTS connector_catalogs (thread_id TEXT PRIMARY KEY, catalog TEXT NOT NULL)");
  const select = db.query<{ catalog: string }, [string]>("SELECT catalog FROM connector_catalogs WHERE thread_id = ?");

  const save = db.query(
    "INSERT INTO connector_catalogs VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET catalog=excluded.catalog",
  );

  return {
    connectorCatalog: (threadId: string) => attempt("connectorCatalog", () => select.get(threadId)?.catalog),
    rememberConnectorCatalog: (threadId: string, catalog: string) =>
      attempt("rememberConnectorCatalog", () => {
        save.run(threadId, catalog);
      }),
  };
}
