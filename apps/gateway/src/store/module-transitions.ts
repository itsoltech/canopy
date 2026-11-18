import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { enabledModules, type ModuleId } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { disconnectBotThreads } from "../bots/module-disconnect.ts";
import { botModuleTransition } from "../bots/module-transition.ts";
import { pauseThreadImports } from "../imports/transitions.ts";
import { lockModuleChanges } from "./module-access.ts";
import { applyThreadModuleTransition } from "./thread-module-transition.ts";

export type ModuleChange = { module: ModuleId; enabled: boolean };

export interface StoredModuleState {
  modules?: JsonValue;
  suspendedModule?: ModuleId | null;
}

export const moduleSettings = (stored: StoredModuleState) =>
  fromJson(ui.ModuleSettingsSchema, stored.modules ?? { enabled: enabledModules() }, { ignoreUnknownFields: true });

const suspended = (enabled: ModuleId[]) => enabledModules().find((module) => !enabled.includes(module)) ?? null;

export function storeModules(modules: ui.ModuleSettings) {
  return { modules: toJson(ui.ModuleSettingsSchema, modules), suspendedModule: suspended(enabledModules(modules)) };
}

/** The durable side effects and the setting commit together on each computer that applies the preference. */
function applyModuleChanges(sql: SqlClient.SqlClient, owner: string, before: ModuleId[], after: ModuleId[]) {
  return Effect.gen(function* () {
    const changes: ModuleChange[] = [];

    if (before.includes("threads") && !after.includes("threads")) {
      yield* sql`UPDATE user_settings SET settings = jsonb_set(settings, '{threadsDisabledVersion}', to_jsonb(version::text))
        WHERE user_id = ${owner}::uuid`;
      yield* pauseThreadImports(sql, owner);
    }

    for (const module of enabledModules()) {
      const enabled = after.includes(module);

      if (enabled === before.includes(module)) continue;
      changes.push({ module, enabled });

      if (module === "threads") yield* applyThreadModuleTransition(sql, owner, enabled);
      else yield* botModuleTransition(sql, owner, enabled);
    }

    // Disabling Bots must interrupt waiting turns before this cleanup can put them back in the queue.
    if (before.length === 2 && after.length === 1) yield* disconnectBotThreads(sql, owner);

    return changes;
  });
}

/** Older databases may already hide a module while its turns are still running. */
export function reconcileModuleChanges(
  sql: SqlClient.SqlClient,
  owner: string,
  stored: StoredModuleState,
  next?: ui.ModuleSettings,
) {
  return Effect.gen(function* () {
    const previous = enabledModules(moduleSettings(stored));
    const applied = enabledModules().filter((module) => module !== stored.suspendedModule);
    const changes = yield* applyModuleChanges(sql, owner, applied, previous);

    if (next) changes.push(...(yield* applyModuleChanges(sql, owner, previous, enabledModules(next))));

    return changes;
  });
}

/** Run before listeners and workers start. The local marker is atomic with cleanup, including after a crash. */
export function initializeModuleExecution(owner: string) {
  return Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* lockModuleChanges(sql, owner);

        const row = (yield* sql<{ settings: StoredModuleState }>`SELECT settings FROM user_settings
        WHERE user_id = ${owner}::uuid FOR UPDATE`)[0];

        if (!row) return;
        const changes = yield* reconcileModuleChanges(sql, owner, row.settings);

        if (!changes.length) return;
        const marker = suspended(enabledModules(moduleSettings(row.settings)));
        yield* sql`UPDATE user_settings SET settings = settings || ${JSON.stringify({ suspendedModule: marker })}::jsonb
        WHERE user_id = ${owner}::uuid`;
      }),
    ),
  );
}
