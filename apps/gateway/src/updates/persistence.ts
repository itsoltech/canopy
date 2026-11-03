import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ui, update } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";

export interface WorkerUpdateRow {
  id: string; name: string; version: string; os: string; arch: string;
  status: { installKind?: string; minWorkerLinkProtocol?: number; workerLinkProtocol?: number; state?: string; reason?: string; targetVersion?: string };
  command?: update.UpdateCommand;
}
/** Uses existing JSONB fields. No schema migration or collision with 0046_mobile_devices. */
export class UpdatePersistence {
  constructor(readonly runtime: CoreRuntime, readonly userId: string) {}
  async admin(): Promise<boolean> {
    const userId = this.userId;
    return this.runtime.runPromise(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ role: string }>`SELECT role FROM users WHERE id = ${userId}::uuid`;
      return rows[0]?.role === "admin";
    }));
  }
  async channel(): Promise<string | undefined> {
    const userId = this.userId;
    return this.runtime.runPromise(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ channel: string | null }>`SELECT settings->>'updateChannel' AS channel FROM user_settings WHERE user_id = ${userId}::uuid`;
      return rows[0]?.channel ?? undefined;
    }));
  }
  async setChannel(channel: string): Promise<void> {
    const userId = this.userId;
    await this.runtime.runPromise(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO user_settings (user_id, settings, version) VALUES (${userId}::uuid, ${JSON.stringify({ updateChannel: channel })}::jsonb, 1)
        ON CONFLICT (user_id) DO UPDATE SET settings = user_settings.settings || EXCLUDED.settings, version = user_settings.version + 1, updated_at = now()`;
    }));
  }
  async workers(): Promise<WorkerUpdateRow[]> {
    const userId = this.userId;
    return this.runtime.runPromise(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ id: string; name: string; version: string; os: string; arch: string; capabilities: { update?: WorkerUpdateRow["status"]; updateCommand?: unknown } }>`
        SELECT id, name, version, os, arch, capabilities FROM workers WHERE archived_at IS NULL AND revoked_at IS NULL
          AND (owner_user_id = ${userId}::uuid OR owner_user_id IS NULL) ORDER BY name`;
      return rows.map((r) => ({ id: r.id, name: r.name, version: r.version, os: r.os, arch: r.arch, status: r.capabilities.update ?? {},
        ...(r.capabilities.updateCommand ? { command: fromJson(update.UpdateCommandSchema, r.capabilities.updateCommand as never) } : {}) }));
    }));
  }
  async hello(workerId: string, hello: update.CheckRequest): Promise<void> {
    const status = { installKind: hello.installKind, minWorkerLinkProtocol: hello.minWorkerLinkProtocol, workerLinkProtocol: hello.workerLinkProtocol };
    await this.runtime.runPromise(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE workers SET version = ${hello.version}, os = ${hello.os}, arch = ${hello.arch},
        capabilities = jsonb_set(capabilities, '{update}', coalesce(capabilities->'update', '{}'::jsonb) || ${JSON.stringify(status)}::jsonb), last_seen_at = now()
        WHERE id = ${workerId}::uuid AND revoked_at IS NULL AND archived_at IS NULL`;
    }));
  }
  async saveCommand(workerId: string, command: update.UpdateCommand): Promise<void> {
    const userId = this.userId;
    await this.runtime.runPromise(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE workers SET capabilities = jsonb_set(capabilities || ${JSON.stringify({ updateCommand: toJson(update.UpdateCommandSchema, command) })}::jsonb,
          '{update}', coalesce(capabilities->'update', '{}'::jsonb) || ${JSON.stringify({ state: "queued", reason: "", targetVersion: command.version })}::jsonb)
        WHERE id = ${workerId}::uuid AND revoked_at IS NULL AND archived_at IS NULL AND (owner_user_id = ${userId}::uuid OR owner_user_id IS NULL)`;
      yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details)
        VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, 'worker.update', 'worker', ${workerId}::uuid, ${JSON.stringify({ version: command.version, force: command.force, allowDowngrade: command.allowDowngrade })}::jsonb)`;
    }));
  }
  async report(workerId: string, report: update.ReportRequest): Promise<void> {
    const status = JSON.stringify({ state: report.state, reason: report.reason, targetVersion: report.version });
    await this.runtime.runPromise(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE workers SET capabilities = jsonb_set(capabilities, '{update}', coalesce(capabilities->'update', '{}'::jsonb) || ${status}::jsonb)
        WHERE id = ${workerId}::uuid AND revoked_at IS NULL AND archived_at IS NULL AND capabilities->'updateCommand'->>'id' = ${report.commandId}`;
    }));
  }
}
