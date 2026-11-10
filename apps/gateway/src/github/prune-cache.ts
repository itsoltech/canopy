import { Effect, Metric } from "effect";
import { githubMetrics } from "./metrics.ts";
import type { SqlClient } from "effect/sql";

/** Bounded LRU maintenance. Identity/link/tombstone rows are never expired. */
export const pruneGitHubCache = (sql: SqlClient.SqlClient, owner: string, reserve = 0) =>
  Effect.gen(function* () {
    const deleted = yield* sql`WITH ranked AS (
      SELECT account_id,access_revision,cache_key,last_read_at,
        sum(octet_length(payload::text)) OVER(ORDER BY last_read_at DESC,account_id,access_revision,cache_key) AS bytes,
        sum(CASE WHEN cache_key LIKE 'logs:%' THEN octet_length(payload::text) ELSE 0 END)
          OVER(ORDER BY last_read_at DESC,account_id,access_revision,cache_key) AS log_bytes
      FROM github_pr_cache WHERE owner_user_id=${owner}::uuid
    ) DELETE FROM github_pr_cache WHERE (owner_user_id,account_id,access_revision,cache_key) IN (
      SELECT c.owner_user_id,c.account_id,c.access_revision,c.cache_key FROM github_pr_cache c
      JOIN ranked r USING(account_id,access_revision,cache_key)
      WHERE c.owner_user_id=${owner}::uuid AND (c.lease_until IS NULL OR c.lease_until<now())
        AND (r.last_read_at<now()-interval '30 days' OR r.bytes>104857600-${reserve}
          OR c.cache_key LIKE 'logs:%' AND (c.verified_at<now()-interval '1 hour' OR r.log_bytes>16777216-${reserve})
          OR c.cache_key LIKE 'patches:%' AND c.verified_at<now()-interval '24 hours'
          OR c.cache_key !~ '^(summary|patches|logs):' AND c.verified_at<now()-interval '7 days'
          OR NOT EXISTS(SELECT 1 FROM github_accounts a WHERE a.owner_user_id=c.owner_user_id
            AND a.id=c.account_id AND a.revision=c.access_revision AND a.status='connected'))
      ORDER BY c.last_read_at LIMIT 256 FOR UPDATE OF c SKIP LOCKED) RETURNING cache_key`;

    yield* Metric.update(githubMetrics.evicted, deleted.length);

    return deleted.length;
  });
