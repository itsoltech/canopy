import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";

type Row = { worker_id: string; device_id: string; state: JsonValue; command: JsonValue };

export class DesktopUpdateStore {
  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
  ) {}

  async list() {
    const owner = this.owner;

    const rows = await this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<Row>`SELECT u.* FROM desktop_updates u
        JOIN workers w ON w.id = u.worker_id JOIN mobile_devices d ON d.id = u.device_id
        WHERE u.owner_user_id = ${owner}::uuid AND w.owner_user_id = ${owner}::uuid
        AND d.owner_user_id = ${owner}::uuid AND w.revoked_at IS NULL AND w.archived_at IS NULL
        AND d.revoked_at IS NULL AND d.client_kind = 'desktop'`;
      }),
    );

    return rows.map((r) => ({
      workerId: r.worker_id,
      deviceId: r.device_id,
      state: fromJson(ui.DesktopUpdateStateSchema, r.state),
      command: fromJson(ui.DesktopUpdateCommandSchema, r.command),
    }));
  }

  async bind(workerId: string, deviceId: string) {
    const owner = this.owner;

    return this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const rows = yield* sql`INSERT INTO desktop_updates (worker_id, device_id, owner_user_id)
        SELECT w.id, d.id, ${owner}::uuid FROM workers w, mobile_devices d
        WHERE w.id::text = ${workerId} AND d.id::text = ${deviceId}
        AND w.owner_user_id = ${owner}::uuid AND d.owner_user_id = ${owner}::uuid
        AND w.revoked_at IS NULL AND w.archived_at IS NULL AND d.revoked_at IS NULL
        AND d.client_kind = 'desktop' AND w.capabilities->'update'->>'installKind' = 'desktop'
        ON CONFLICT (worker_id) DO UPDATE SET device_id = EXCLUDED.device_id,
          state = CASE WHEN desktop_updates.device_id = EXCLUDED.device_id THEN desktop_updates.state ELSE '{}'::jsonb END,
          command = CASE WHEN desktop_updates.device_id = EXCLUDED.device_id THEN desktop_updates.command ELSE '{}'::jsonb END
        WHERE desktop_updates.device_id = EXCLUDED.device_id OR EXISTS
          (SELECT 1 FROM mobile_devices old WHERE old.id = desktop_updates.device_id AND old.revoked_at IS NOT NULL)
        RETURNING worker_id`;

        return rows.length > 0;
      }),
    );
  }

  async save(
    workerId: string,
    deviceId: string,
    state: ui.DesktopUpdateState,
    command?: ui.DesktopUpdateCommand,
    action?: string,
  ) {
    const owner = this.owner;

    return this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows =
              yield* sql`UPDATE desktop_updates SET state = ${JSON.stringify(toJson(ui.DesktopUpdateStateSchema, state))}::jsonb,
          command = CASE WHEN ${!!command} THEN ${JSON.stringify(toJson(ui.DesktopUpdateCommandSchema, command ?? create(ui.DesktopUpdateCommandSchema)))}::jsonb ELSE command END,
          updated_at = now() WHERE worker_id::text = ${workerId} AND device_id::text = ${deviceId}
          AND owner_user_id = ${owner}::uuid
          AND EXISTS (SELECT 1 FROM workers w, mobile_devices d WHERE w.id = desktop_updates.worker_id
            AND d.id = desktop_updates.device_id AND w.owner_user_id = ${owner}::uuid AND d.owner_user_id = ${owner}::uuid
            AND w.revoked_at IS NULL AND w.archived_at IS NULL AND d.revoked_at IS NULL)
          RETURNING worker_id`;

            if (rows.length && action)
              yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${owner}::uuid, ${action}, 'worker', ${workerId}::uuid,
          ${JSON.stringify({
            deviceId,
            requestId: state.requestId,
            version: state.targetVersion || state.availableVersion,
            outcome: state.phase,
            reason: state.reason,
          })}::jsonb)`;

            return rows.length > 0;
          }),
        );
      }),
    );
  }
}
