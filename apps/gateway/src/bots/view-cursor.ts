import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

/** Cursor scope prevents a checkpoint for one chat/exchange from suppressing another's history. */
export function botViewCursor(sql: SqlClient.SqlClient, owner: string, scope: string, cursor: string, bot?: string) {
  return Effect.gen(function* () {
    const clock = (yield* sql<{ epoch: string; revision: string }>`SELECT epoch,revision::text
      FROM bot_view_clock WHERE owner_user_id=${owner}::uuid`)[0];

    const current = clock ? `${clock.epoch}:${clock.revision}:${scope}` : "";
    const match = /^([a-f0-9-]{36}):(\d+):(.+)$/.exec(cursor.replace(/:[a-f0-9]{64}$/, ""));

    if (
      !clock ||
      !match ||
      match[1] !== clock.epoch ||
      match[3] !== scope ||
      BigInt(match[2]!) > BigInt(clock.revision)
    )
      return { cursor: current };

    const changes = yield* sql<{ revision: string; bot_id: string; kind: string; entity_id: string }>`
      SELECT revision::text,bot_id,kind,entity_id FROM bot_view_changes WHERE owner_user_id=${owner}::uuid
        AND revision>${match[2]!}::bigint AND revision<=${clock.revision}::bigint`;

    if (BigInt(changes.length) !== BigInt(clock.revision) - BigInt(match[2]!)) return { cursor: current };
    const own = changes.filter((c) => !bot || c.bot_id === bot);

    if (own.some((c) => c.kind === "reset")) return { cursor: current };
    const keys = (kind: string) => [...new Set(own.filter((c) => c.kind === kind).map((c) => c.entity_id))];

    return { cursor: current, selection: { ids: keys("bot_messages"), turns: keys("bot_turns") } };
  });
}
