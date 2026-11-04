import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Code, ConnectError } from "@connectrpc/connect";

export function marketplaces(sql: SqlClient.SqlClient, owner: string) {
  return sql<{
    marketplace: JsonValue;
  }>`SELECT marketplace FROM agent_marketplaces WHERE owner_user_id = ${owner}::uuid ORDER BY created_at, id`.pipe(
    Effect.map((rows) => rows.map((r) => fromJson(ui.EnvironmentMarketplaceSchema, r.marketplace))),
  );
}

export function plugins(sql: SqlClient.SqlClient, owner: string) {
  return sql<{
    plugin: JsonValue;
  }>`SELECT plugin FROM agent_plugins WHERE owner_user_id = ${owner}::uuid ORDER BY created_at, id`.pipe(
    Effect.map((rows) => rows.map((r) => fromJson(ui.LibraryPluginSchema, r.plugin))),
  );
}

export function saveMarketplace(sql: SqlClient.SqlClient, owner: string, marketplace: ui.EnvironmentMarketplace) {
  const json = JSON.stringify(toJson(ui.EnvironmentMarketplaceSchema, marketplace));

  return sql`INSERT INTO agent_marketplaces (id, owner_user_id, marketplace) VALUES (${marketplace.id}::uuid, ${owner}::uuid, ${json}::jsonb)
    ON CONFLICT (id) DO UPDATE SET marketplace = EXCLUDED.marketplace WHERE agent_marketplaces.owner_user_id = ${owner}::uuid`;
}

export function savePlugin(sql: SqlClient.SqlClient, owner: string, plugin: ui.LibraryPlugin) {
  const json = JSON.stringify(toJson(ui.LibraryPluginSchema, plugin));

  return sql`INSERT INTO agent_plugins (id, owner_user_id, plugin) VALUES (${plugin.assignment!.id}::uuid, ${owner}::uuid, ${json}::jsonb)
    ON CONFLICT (id) DO UPDATE SET plugin = EXCLUDED.plugin WHERE agent_plugins.owner_user_id = ${owner}::uuid`;
}

export function pluginVersion(sql: SqlClient.SqlClient, owner: string, id: string, version: bigint) {
  return Effect.gen(function* () {
    const rows = yield* sql<{
      plugin: JsonValue;
    }>`SELECT plugin FROM agent_plugin_versions WHERE owner_user_id = ${owner}::uuid AND plugin_id = ${id}::uuid AND version = ${version}`;

    if (!rows[0]) return yield* Effect.fail(new ConnectError("Plugin version not found.", Code.NotFound));

    return fromJson(ui.LibraryPluginSchema, rows[0].plugin);
  });
}

export function addPluginVersion(sql: SqlClient.SqlClient, owner: string, plugin: ui.LibraryPlugin) {
  const json = JSON.stringify(toJson(ui.LibraryPluginSchema, plugin));

  return sql`INSERT INTO agent_plugin_versions (owner_user_id, plugin_id, version, plugin)
    VALUES (${owner}::uuid, ${plugin.assignment!.id}::uuid, ${plugin.assignment!.version}, ${json}::jsonb)`;
}
