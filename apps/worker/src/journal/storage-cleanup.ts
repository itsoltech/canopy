import type { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import type { JournalError } from "./journal.ts";

export interface StorageCleanupGrant {
  readonly threadId: string;
  readonly provider: number;
  readonly providerProfileId: string;
  readonly providerThreadIds: readonly string[];
  /** Captured after WorkerConfig was applied; empty means an unresolved grant that must stay pending. */
  readonly homePath: string;
}

type Attempt = <A>(operation: string, run: () => A) => Effect.Effect<A, JournalError>;

export function storageCleanup(db: Database, attempt: Attempt) {
  db.exec(`CREATE TABLE IF NOT EXISTS storage_cleanup (
    thread_id TEXT PRIMARY KEY, provider INTEGER NOT NULL, provider_profile_id TEXT NOT NULL,
    provider_thread_ids TEXT NOT NULL, home_path TEXT NOT NULL DEFAULT '', granted_at INTEGER NOT NULL, completed_at INTEGER
  )`);
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(storage_cleanup)").all();

  if (!columns.some((column) => column.name === "home_path"))
    db.exec("ALTER TABLE storage_cleanup ADD COLUMN home_path TEXT NOT NULL DEFAULT ''");

  const upsert =
    db.query(`INSERT INTO storage_cleanup(thread_id,provider,provider_profile_id,provider_thread_ids,home_path,granted_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET provider=excluded.provider,
    provider_profile_id=excluded.provider_profile_id,provider_thread_ids=excluded.provider_thread_ids,
    home_path=CASE WHEN storage_cleanup.home_path<>'' THEN storage_cleanup.home_path ELSE excluded.home_path END,
    granted_at=excluded.granted_at,completed_at=NULL`);

  const rows = db.query<
    {
      thread_id: string;
      provider: number;
      provider_profile_id: string;
      provider_thread_ids: string;
      home_path: string;
    },
    []
  >(
    "SELECT thread_id,provider,provider_profile_id,provider_thread_ids,home_path FROM storage_cleanup WHERE completed_at IS NULL ORDER BY granted_at LIMIT 128",
  );

  return {
    hasStorageCleanup: (threadId: string) =>
      attempt(
        "hasStorageCleanup",
        () => db.query("SELECT 1 FROM storage_cleanup WHERE thread_id=?").get(threadId) !== null,
      ),
    grantStorageCleanup: (grant: StorageCleanupGrant) =>
      attempt("grantStorageCleanup", () => {
        upsert.run(
          grant.threadId,
          grant.provider,
          grant.providerProfileId,
          JSON.stringify(grant.providerThreadIds),
          grant.homePath,
          Date.now(),
        );
      }),
    pendingStorageCleanup: () =>
      attempt("pendingStorageCleanup", () =>
        rows.all().map((r): StorageCleanupGrant => ({
          threadId: r.thread_id,
          provider: r.provider,
          providerProfileId: r.provider_profile_id,
          providerThreadIds: Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(r.provider_thread_ids)),
          homePath: r.home_path,
        })),
      ),
    completeStorageCleanup: (threadId: string) =>
      attempt("completeStorageCleanup", () => {
        db.query("UPDATE storage_cleanup SET completed_at=? WHERE thread_id=? AND completed_at IS NULL").run(
          Date.now(),
          threadId,
        );
        db.query("DELETE FROM retry_requests WHERE thread_id=?").run(threadId);
      }),
  };
}
