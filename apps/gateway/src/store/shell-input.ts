import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ShellResultSchema, type ShellInputPrepared } from "@canopy/contracts";
import { shellInputText } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

export const storedShellResult = (value: JsonValue | undefined) =>
  value ? fromJson(ShellResultSchema, value) : undefined;

/** Also updates fallback turns: the original running turn may have ended while its steer's shell ran. */
export const applyShellInput = (sql: SqlClient.SqlClient, threadId: string, prepared: ShellInputPrepared) =>
  Effect.gen(function* () {
    if (!prepared.result || !prepared.inputId) return;
    const result = prepared.result;
    const text = result.status === "completed" ? shellInputText(result) : "";
    const patch = JSON.stringify({ text, shellResult: toJson(ShellResultSchema, result) });
    yield* sql`UPDATE turns SET input = input || ${patch}::jsonb
    WHERE thread_id = ${threadId}::uuid AND input->>'shellInputId' = ${prepared.inputId}
      AND (input->'shellResult'->>'status' IS NULL OR input->'shellResult'->>'status' = 'running')`;
    yield* sql`UPDATE turn_steers SET input = input || ${patch}::jsonb, updated_at = now(),
    status = CASE WHEN ${result.status} IN ('failed', 'interrupted') THEN 'failed' ELSE status END,
    reason = CASE WHEN ${result.status} IN ('failed', 'interrupted') THEN ${result.reason} ELSE reason END
    WHERE thread_id = ${threadId}::uuid AND input->>'shellInputId' = ${prepared.inputId}
      AND (input->'shellResult'->>'status' IS NULL OR input->'shellResult'->>'status' = 'running')`;
  });
