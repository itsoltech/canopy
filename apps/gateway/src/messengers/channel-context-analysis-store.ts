import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { BotRow } from "../bots/types.ts";
import { lockedOwnerModule } from "../store/module-access.ts";
import { linkedMessengerActive } from "./linked-account.ts";
import { channelRoot, type ChannelEntry, type ChannelScope } from "./channel-context-read.ts";

export interface ChannelAnalysis extends ChannelScope {
  bot_id: string;
  account_id: string;
  epoch: string;
  lease_id: string;
  cursor: string;
  configuration: BotRow["configuration"];
}

export interface AnalyzedTopic {
  id: string;
  title: string;
  aliases: readonly string[];
  summary: string;
  open: boolean;
  sourceIds: readonly string[];
  dependencies: readonly string[];
}

function eligibleScope(sql: SqlClient.SqlClient, owner: string) {
  return sql`r.owner_user_id=${owner}::uuid AND b.owner_user_id=r.owner_user_id AND a.owner_user_id=r.owner_user_id
    AND r.channel_context AND r.deleted_at IS NULL AND s.channel_id=ANY(r.channel_ids)
    AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
    AND a.enabled AND a.deleted_at IS NULL AND ${linkedMessengerActive(sql)}`;
}

/** Reserve one durable, rate-limited batch per owner, across gateway processes. */
export function reserveChannelAnalysis(sql: SqlClient.SqlClient, owner: string, now: Date) {
  return sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* lockedOwnerModule(sql, owner, "bots"))) return undefined;

      const [lock] = yield* sql<{ acquired: boolean }>`SELECT pg_try_advisory_xact_lock(
        hashtextextended('canopy.slack_analysis:' || ${owner}::uuid::text, 0)) AS acquired`;

      if (!lock?.acquired) return undefined;

      const [scope] = yield* sql<Omit<ChannelAnalysis, "lease_id">>`SELECT s.route_id,s.channel_id,s.epoch::text,
        s.cursor::text,r.bot_id,r.account_id,b.configuration
        FROM slack_channel_contexts s JOIN bot_channel_routes r ON r.id=s.route_id
        JOIN messenger_accounts a ON a.id=r.account_id JOIN bots b ON b.id=r.bot_id
        WHERE ${eligibleScope(sql, owner)}
          AND s.head>s.cursor AND s.next_analysis_at<=${now}
          AND NOT EXISTS(SELECT 1 FROM slack_channel_contexts other JOIN bot_channel_routes route
            ON route.id=other.route_id WHERE route.owner_user_id=${owner}::uuid AND other.lease_until>${now})
        ORDER BY s.next_analysis_at,s.route_id,s.channel_id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`;

      if (!scope) return undefined;
      const leaseId = Bun.randomUUIDv7();
      const nextAt = new Date(now.getTime() + 60_000);
      yield* sql`UPDATE slack_channel_contexts SET lease_id=${leaseId}::uuid,lease_until=${nextAt},next_analysis_at=${nextAt}
        WHERE route_id=${scope.route_id}::uuid AND channel_id=${scope.channel_id}`;

      return { ...scope, lease_id: leaseId };
    }),
  );
}

/** Hold the permissions and revision through command handoff or application of its result. */
export function lockChannelAnalysis(sql: SqlClient.SqlClient, owner: string, job: ChannelAnalysis, now: Date) {
  return Effect.gen(function* () {
    if (!(yield* lockedOwnerModule(sql, owner, "bots"))) return false;
    yield* sql`SELECT id FROM bots WHERE id=${job.bot_id}::uuid AND owner_user_id=${owner}::uuid FOR SHARE`;
    yield* sql`SELECT id FROM messenger_accounts WHERE id=${job.account_id}::uuid AND owner_user_id=${owner}::uuid FOR SHARE`;

    const live = yield* sql`SELECT s.route_id FROM slack_channel_contexts s JOIN bot_channel_routes r ON r.id=s.route_id
      JOIN messenger_accounts a ON a.id=r.account_id JOIN bots b ON b.id=r.bot_id
      WHERE ${eligibleScope(sql, owner)} AND s.route_id=${job.route_id}::uuid AND s.channel_id=${job.channel_id}
        AND r.bot_id=${job.bot_id}::uuid AND r.account_id=${job.account_id}::uuid
        AND b.configuration=${JSON.stringify(job.configuration)}::jsonb
        AND s.epoch=${job.epoch}::bigint AND s.lease_id=${job.lease_id}::uuid AND s.lease_until>${now}
      FOR UPDATE OF s`;

    return live.length > 0;
  });
}

export function channelAnalysisEntries(sql: SqlClient.SqlClient, job: ChannelAnalysis) {
  return sql<
    ChannelEntry & { deleted: boolean }
  >`SELECT message_id,thread_id,author_id,own_reply,left(text,2000) AS text,
    change_no::text,slack_ts::text,deleted
    FROM slack_channel_context_messages WHERE route_id=${job.route_id}::uuid AND channel_id=${job.channel_id}
      AND change_no>${job.cursor}::bigint ORDER BY slack_channel_context_messages.change_no LIMIT 40`;
}

export function retryChannelAnalysis(sql: SqlClient.SqlClient, job: ChannelAnalysis, now: Date) {
  return sql`UPDATE slack_channel_contexts SET lease_id=NULL,lease_until=NULL,
    next_analysis_at=CASE WHEN epoch=${job.epoch}::bigint
      THEN greatest(next_analysis_at,${new Date(now.getTime() + 120_000)}) ELSE next_analysis_at END
    WHERE route_id=${job.route_id}::uuid AND channel_id=${job.channel_id} AND lease_id=${job.lease_id}::uuid`;
}

export function finishChannelAnalysis(
  sql: SqlClient.SqlClient,
  job: ChannelAnalysis,
  through: string,
  topics: readonly AnalyzedTopic[],
) {
  return Effect.gen(function* () {
    for (const topic of topics) {
      // Persist explicit source references for ranking and all visible inputs for invalidation.
      const entries = yield* sql<ChannelEntry>`SELECT * FROM slack_channel_context_messages
        WHERE route_id=${job.route_id}::uuid AND channel_id=${job.channel_id}
          AND message_id=ANY(${topic.sourceIds}::text[]) AND NOT deleted`;

      const roots = [...new Set(entries.map(channelRoot))];
      const authors = [...new Set(entries.map((entry) => entry.author_id).filter(Boolean))];
      yield* sql`INSERT INTO slack_channel_topics(route_id,channel_id,id,title,aliases,summary,is_open,
        source_ids,roots,authors,dependencies,search,activity)
        SELECT ${job.route_id}::uuid,${job.channel_id},${topic.id}::uuid,${topic.title},${topic.aliases}::text[],
          ${topic.summary},${topic.open},${topic.sourceIds}::text[],${roots}::text[],${authors}::text[],
          ${topic.dependencies}::text[],to_tsvector('simple',${[topic.title, ...topic.aliases, topic.summary].join(" ")}),max(slack_ts)
        FROM slack_channel_context_messages WHERE route_id=${job.route_id}::uuid AND channel_id=${job.channel_id}
          AND message_id=ANY(${topic.sourceIds}::text[]) AND NOT deleted
        ON CONFLICT(route_id,channel_id,id) DO UPDATE SET title=excluded.title,aliases=excluded.aliases,
          summary=excluded.summary,is_open=excluded.is_open,source_ids=excluded.source_ids,roots=excluded.roots,
          authors=excluded.authors,dependencies=excluded.dependencies,search=excluded.search,activity=excluded.activity`;
    }

    yield* sql`UPDATE slack_channel_contexts SET cursor=${through}::bigint,lease_id=NULL,lease_until=NULL
      WHERE route_id=${job.route_id}::uuid AND channel_id=${job.channel_id}`;
  });
}
