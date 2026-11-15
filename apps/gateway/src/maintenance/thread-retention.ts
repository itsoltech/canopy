import { Data, Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { pruneThreadContent } from "./thread-content.ts";

class ThreadContentBusy extends Data.TaggedError("ThreadContentBusy") {}

const lockContent = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    // Derived journals take global -> content. Never hold content while waiting for global.
    const journal = (yield* sql<{ locked: boolean }>`SELECT pg_try_advisory_xact_lock(
      hashtextextended('canopy.thread_mirror_journal',0)) AS locked`)[0];

    if (!journal?.locked) return yield* Effect.fail(new ThreadContentBusy());

    const row = (yield* sql<{ locked: boolean }>`SELECT pg_try_advisory_xact_lock(
      hashtextextended('canopy.thread_content.'||${id},0)) AS locked`)[0];

    if (!row?.locked) return yield* Effect.fail(new ThreadContentBusy());
  });

/** The row lock also fences restore, unarchive, new children/forks and event ingestion. */
const eligible = (sql: SqlClient.SqlClient, owner: string, id: string, days: number) =>
  sql<{ id: string }>`SELECT t.id FROM threads t
    WHERE t.id=${id}::uuid AND t.owner_user_id=${owner}::uuid AND t.purged_at IS NULL
      AND t.deleted_at IS NULL AND t.archived_at<=now()-make_interval(days=>${days})
      AND t.moved_to IS NULL AND t.rewind_pending_id IS NULL
      AND thread_retention_ready(t.id)`;

const fenceArchivedThread = (sql: SqlClient.SqlClient, owner: string) =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        // SHARE, not KEY SHARE: disabling retention must serialize with qualification.
        const locked = yield* sql`SELECT user_id FROM user_settings WHERE user_id=${owner}::uuid FOR SHARE SKIP LOCKED`;

        if (!locked.length) return [];

        const settings = (yield* sql<{ days: number }>`SELECT CASE
      WHEN settings#>>'{threadRetention,archivedThreadDays}' ~ '^[0-9]{1,5}$'
        THEN (settings#>>'{threadRetention,archivedThreadDays}')::int ELSE 0 END AS days
      FROM user_settings WHERE user_id=${owner}::uuid`)[0];

        if (!settings || settings.days < 1 || settings.days > 36500) return [];

        const candidates = yield* sql<{ id: string }>`SELECT t.id FROM threads t
      WHERE t.owner_user_id=${owner}::uuid AND t.purged_at IS NULL AND t.deleted_at IS NULL
        AND t.archived_at<=now()-make_interval(days=>${settings.days})
        AND t.moved_to IS NULL AND t.rewind_pending_id IS NULL
        AND thread_retention_ready(t.id)
      ORDER BY t.archived_at,t.id LIMIT 256 FOR UPDATE OF t SKIP LOCKED`;

        for (const candidate of candidates) {
          yield* lockContent(sql, candidate.id);

          // Read again after acquiring the execution row; dependency changes may have committed meanwhile.
          if (!(yield* eligible(sql, owner, candidate.id, settings.days)).length) continue;

          yield* sql`UPDATE threads SET purged_at=now(),deleted_at=now(),deletion_batch_id=id,
        title_requested=false,title_revision=title_revision+1,title='',title_context='',settings='{}'::jsonb,
        status_detail=NULL,newest_pull_request=NULL,schedule_name=''
        WHERE id=${candidate.id}::uuid`;

          return [candidate.id];
        }

        return [];
      }),
    )
    .pipe(Effect.catchTag("ThreadContentBusy", () => Effect.succeed([])));

const prunePendingThread = (sql: SqlClient.SqlClient, owner: string) =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        const pending = (yield* sql<{ id: string }>`SELECT id FROM threads WHERE owner_user_id=${owner}::uuid
      AND purged_at IS NOT NULL AND purge_completed_at IS NULL
      ORDER BY purged_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)[0];

        if (!pending) return 0;

        yield* lockContent(sql, pending.id);
        yield* sql`SELECT set_config('canopy.thread_purge',${pending.id},true)`;

        return yield* pruneThreadContent(sql, pending.id);
      }),
    )
    .pipe(Effect.catchTag("ThreadContentBusy", () => Effect.succeed(0)));

/** Qualification is reversible until this transaction commits. Started purges finish after an opt-out. */
export const pruneArchivedThreads = (sql: SqlClient.SqlClient, owner: string) =>
  Effect.gen(function* () {
    const ids = yield* fenceArchivedThread(sql, owner);

    const touched = yield* prunePendingThread(sql, owner);

    return { ids, touched: touched + ids.length };
  });
