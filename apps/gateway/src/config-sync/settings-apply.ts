import { Effect, Result } from "effect";
import { type SqlClient } from "effect/sql";
import type { SharedHost } from "../computers/shared.ts";
import { SettingsStore } from "../store/settings.ts";
import { compareClock } from "./clock.ts";
import type { ConfigRow } from "./persistence.ts";
import { instanceIds } from "./aliases.ts";
import {
  mapSettingsInstances,
  materializeSettings,
  settingsRequest,
  settingsValues,
  type SettingsJson,
} from "./settings.ts";

export type SettingsRow = { settings: SettingsJson; version: string; updated_at: Date };

export function applySettings(sql: SqlClient.SqlClient, owner: string, row: ConfigRow, self: string, host: SharedHost) {
  return Effect.gen(function* () {
    const current = (yield* sql<SettingsRow>`SELECT * FROM user_settings WHERE user_id=${owner}::uuid`)[0];

    const deleted =
      row.deleted.value === true && Object.values(row.fields).every((f) => compareClock(f.hlc, row.deleted.hlc) <= 0);

    const ids = yield* instanceIds(sql, owner);

    const values = deleted
      ? Object.fromEntries(Object.keys(settingsValues(current?.settings ?? {}, self)).map((key) => [key, null]))
      : mapSettingsInstances(
          Object.fromEntries(Object.entries(row.fields).map(([key, field]) => [key, field.value])),
          ids.toLocal,
        );

    const parsed = yield* Effect.try(() =>
      settingsRequest(materializeSettings(current?.settings ?? {}, values, self), BigInt(current?.version ?? 0)),
    ).pipe(Effect.result);

    if (Result.isFailure(parsed)) {
      row.unsupported = "Not supported on this computer";

      return false;
    }

    const request = parsed.success;

    const valid = yield* Effect.tryPromise(() => host.validateSettings?.(request) ?? Promise.resolve()).pipe(
      Effect.result,
    );

    if (Result.isFailure(valid)) {
      row.unsupported = "Not supported on this computer";

      return false;
    }

    const settings = yield* SettingsStore;
    yield* settings.updateUser({
      userId: owner,
      synced: true,
      expectedVersion: request.expectedVersion,
      ...(request.appearance && { appearance: request.appearance }),
      ...(request.threadDefaults && { threadDefaults: request.threadDefaults }),
      ...(request.general && { general: request.general }),
      ...(request.composer && { composer: request.composer }),
      ...(request.sidebar && { sidebar: request.sidebar }),
      ...(request.textGeneration && { textGeneration: request.textGeneration }),
      ...(request.cliUpdates && { cliUpdates: request.cliUpdates }),
      timezone: request.timezone ?? "",
    });

    return (
      JSON.stringify(current?.settings["cliUpdates"] ?? {}) !==
      JSON.stringify(request.cliUpdates ? { intervalMinutes: request.cliUpdates.intervalMinutes } : {})
    );
  });
}
