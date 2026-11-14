import type { MigrationStore } from "./store.ts";

/** What a new server may hold before an import (docs/desktop-server-migration.md §3): its own identity and
 * Network access, runtime clocks and limiters, default settings, the operator's paired devices, its own
 * audit and the migration sessions. Deny by default: any other table with a row is data, and a table added
 * later blocks imports until it is classified here or by the importer. */
export const BOOTSTRAP_TABLES = [
  "schema_migrations",
  "computer_identity",
  "network_access",
  "computer_pairing_budget",
  "computer_thread_clock",
  "computer_thread_changes",
  "config_clock",
  "github_api_slots",
  "github_api_budgets",
  "database_maintenance",
  "diagnostics_state",
  "diagnostics_rollups",
  "user_settings",
  "mobile_devices",
  "mobile_pairings",
  "audit_log",
  "server_migration_sessions",
  "server_migration_sources",
  "server_migration_targets",
] as const;

/** Tables whose bootstrap rows a server creates itself; any other row is data. $1 is the owner: a second
 * user is another owner's data, which v1 never merges with. */
const BOOTSTRAP_ROWS = {
  users: "id <> $1::uuid",
  projects: "kind <> 'scratch'",
  provider_instances: "id <> 'native'",
  config_items: "NOT (kind = 'instance' AND local_id = 'native')",
} satisfies Record<string, string>;

/** The tables that make this server non-empty, by name only (no values). */
export async function occupiedTarget(store: MigrationStore) {
  const occupied = await store.occupied([...BOOTSTRAP_TABLES, ...Object.keys(BOOTSTRAP_ROWS)]);

  for (const [table, data] of Object.entries(BOOTSTRAP_ROWS)) {
    const rows = await store.query<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${table} WHERE ${data}) AS found`,
      data.includes("$1") ? [store.owner] : [],
    );

    if (rows[0]?.found) occupied.push(table);
  }

  return occupied;
}
