import type { Database } from "bun:sqlite";

export type JournalStatistics = { events: number; bytes: number; oldest: number };

/** Exact transactional counters in TEMP memory. No second durable metrics store or polling scan. */
export function journalStatistics(db: Database) {
  db.exec(`CREATE INDEX IF NOT EXISTS events_created_at ON events(created_at);
    CREATE TEMP TABLE journal_diagnostics(events INTEGER NOT NULL, bytes INTEGER NOT NULL);
    INSERT INTO journal_diagnostics SELECT count(*),coalesce(sum(length(payload)),0) FROM events;
    CREATE TEMP TRIGGER journal_diagnostics_insert AFTER INSERT ON main.events BEGIN
      UPDATE journal_diagnostics SET events=events+1,bytes=bytes+length(NEW.payload);
    END;
    CREATE TEMP TRIGGER journal_diagnostics_delete AFTER DELETE ON main.events BEGIN
      UPDATE journal_diagnostics SET events=events-1,bytes=bytes-length(OLD.payload);
    END;`);
  const counts = db.query<{ events: number; bytes: number }, []>("SELECT events,bytes FROM journal_diagnostics");
  const oldest = db.query<{ created_at: number }, []>("SELECT created_at FROM events ORDER BY created_at LIMIT 1");

  return (): JournalStatistics => ({ ...counts.get()!, oldest: oldest.get()?.created_at ?? 0 });
}
