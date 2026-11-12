import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { PermissionMode, ui } from "@canopy/contracts";
import { SPAWN_PERMISSION_MODES, type SpawnPermissionMode } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { callerMode, thread } from "./agent-bus-queries.ts";
import type { CallSource } from "./agent-bus-types.ts";
import { Invalid } from "./errors.ts";
import type { ThreadRow } from "./rows.ts";

export interface AutomatedAccess {
  permissionModeNote?: string;
}

/** Applies the computer's ceiling using its last authenticated worker report, including while offline. */
export const automatedPermission = (
  sql: SqlClient.SqlClient,
  owner: string,
  workerId: string | null,
  mode: SpawnPermissionMode,
  permissionModeNote = "",
) =>
  Effect.gen(function* () {
    if (mode === "full_access" && workerId) {
      const workers = yield* sql<{
        allowed: boolean;
      }>`SELECT coalesce((capabilities->>'fullAccess')::boolean, false) AS allowed
        FROM workers WHERE id = ${workerId}::uuid AND (owner_user_id IS NULL OR owner_user_id = ${owner}::uuid)
          AND revoked_at IS NULL AND archived_at IS NULL`;

      if (!workers[0]?.allowed)
        return {
          permissionMode: "FULL_AUTO",
          permissionModeNote:
            "This computer limits Full access to Full auto. Choose another mode or enable Full access on this computer.",
        };
    }

    return { permissionMode: mode.toUpperCase(), permissionModeNote };
  });

/** Resolved in the creation transaction; the model may only narrow an owner's choice for compatibility. */
export const subagentPermission = (
  sql: SqlClient.SqlClient,
  source: CallSource,
  caller: ThreadRow,
  requested?: SpawnPermissionMode,
  workerId: string | null = caller.worker_id,
) =>
  Effect.gen(function* () {
    yield* sql`SELECT id FROM threads WHERE id = ${source.threadId}::uuid FOR UPDATE`;
    const parent = yield* thread(sql, source.threadId);

    if (parent.owner_user_id !== caller.owner_user_id || parent.id !== caller.id || parent.archived_at)
      return yield* Effect.fail(new Invalid("Parent thread not found."));

    const settings = (yield* sql<{ defaults: JsonValue | null }>`SELECT settings->'threadDefaults' AS defaults
      FROM user_settings WHERE user_id = ${parent.owner_user_id}::uuid`)[0]?.defaults;

    const fixed = settings
      ? fromJson(ui.ThreadDefaultsSchema, settings, { ignoreUnknownFields: true }).subagentPermissionMode
      : PermissionMode.UNSPECIFIED;

    const current = yield* callerMode(sql, source, parent);
    const configured = SPAWN_PERMISSION_MODES.find((mode) => mode.toUpperCase() === PermissionMode[fixed]) ?? current;
    const rank = (mode: SpawnPermissionMode) => SPAWN_PERMISSION_MODES.indexOf(mode);
    const capped = rank(configured) > rank(current);
    let selected = capped ? current : configured;

    if (requested && rank(requested) < rank(selected)) selected = requested;

    return yield* automatedPermission(
      sql,
      parent.owner_user_id,
      workerId,
      selected,
      capped
        ? "The parent’s mode limits subagent permissions. Change permissions in the parent thread to allow more access."
        : "",
    );
  });
