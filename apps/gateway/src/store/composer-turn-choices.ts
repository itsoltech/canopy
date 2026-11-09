import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { DISPATCHED } from "./turn-select.ts";
import { permissionModeOf } from "./ui-mappers.ts";

/** Only an open thread's snapshot/watch needs these choices; ordinary metadata reads stay cheap. */
export function composerTurnChoices(sql: SqlClient.SqlClient, threadId: string, ownerUserId: string) {
  return sql<{
    turn_id: string;
    model: string;
    effort: string;
    permission_mode: string;
  }>`SELECT u.id AS turn_id,
      CASE WHEN u.status='queued' AND NOT ${sql.literal(DISPATCHED)}
        THEN coalesce(nullif(u.model,''),t.list_settings->>'model','') ELSE u.model END AS model,
      CASE WHEN u.status='queued' AND NOT ${sql.literal(DISPATCHED)}
        THEN coalesce(nullif(u.effort,''),t.list_settings->>'effort','') ELSE u.effort END AS effort,
      coalesce(nullif(u.permission_mode,''),t.list_settings->>'permissionMode','ASK') AS permission_mode
    FROM turns u JOIN threads t ON t.id=u.thread_id
    WHERE u.thread_id=${threadId}::uuid AND t.owner_user_id=${ownerUserId}::uuid
      AND u.author_user_id=${ownerUserId}::uuid AND u.trigger='user' AND u.withdrawn IS NULL
      AND NOT (u.input ? 'shellCommand')
    ORDER BY u.ordinal DESC LIMIT 1`.pipe(
    Effect.map((rows) => {
      const row = rows[0];

      return row
        ? create(ui.ComposerTurnChoicesSchema, {
            turnId: row.turn_id,
            model: row.model,
            effort: row.effort,
            permissionMode: permissionModeOf(row.permission_mode),
          })
        : undefined;
    }),
  );
}
