import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { COMPOSER_CHOICE_SELECT, type ComposerChoiceColumns } from "./composer-choice-select.ts";
import { toUiComposerChoices } from "./ui-mappers.ts";

/** Uses the same small projection as thread metadata, independently of the history window. */
export function composerTurnChoices(sql: SqlClient.SqlClient, threadId: string, ownerUserId: string) {
  return sql
    .unsafe<ComposerChoiceColumns>(
      `SELECT c.* FROM threads t CROSS JOIN LATERAL (${COMPOSER_CHOICE_SELECT}) c
        WHERE t.id=$1::uuid AND t.owner_user_id=$2::uuid`,
      [threadId, ownerUserId],
    )
    .pipe(Effect.map((rows) => (rows[0] ? toUiComposerChoices(rows[0]) : undefined)));
}
