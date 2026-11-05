import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { configLock, type ConfigRow } from "./persistence.ts";
import { environmentManaged } from "./environment-values.ts";
import { projectWriter } from "./project-writer.ts";
import type { Values } from "./provider-values.ts";

type Stamped = { id: string; updated_at: Date };

type VersionRow = { item: string; version: string; content_hash: string; commit: string; checksum: string };

const options = { ignoreUnknownFields: true };

/**
 * Local library writes and their versions commit together, with the configuration clock locked first, the order
 * a received batch uses.
 */
export const environmentTransaction = <A, E, R>(sql: SqlClient.SqlClient, effect: Effect.Effect<A, E, R>) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT 1 FROM config_clock ORDER BY owner_user_id FOR UPDATE`;
      const value = yield* effect;
      yield* recordEnvironment(sql);

      return value;
    }),
  );

export function recordEnvironment(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const owners = yield* sql<{ owner_user_id: string; node_id: string }>`SELECT owner_user_id::text,node_id
      FROM computer_identity ORDER BY owner_user_id`;

    for (const owner of owners) yield* recordOwner(sql, owner.owner_user_id, owner.node_id);
  });
}

const assignment = (item: ui.LibrarySkill): Values => ({
  harnesses: item.harnesses,
  selector: item.selector ? toJson(ui.EnvironmentSelectorSchema, item.selector) : null,
  deviceHome: item.deviceHome,
  platformHome: item.platformHome,
});

/** The selected version by content and every version this computer has. */
function versionValues(versions: readonly VersionRow[], id: string, selected: bigint): Values {
  const own = versions.filter((v) => v.item === id);

  return {
    selected: own.find((v) => BigInt(v.version) === selected)?.content_hash ?? null,
    ...Object.fromEntries(
      own.map((v) => [`version.${v.content_hash}`, { commit: v.commit, checksum: v.checksum } satisfies JsonValue]),
    ),
  };
}

function recordOwner(sql: SqlClient.SqlClient, owner: string, node: string) {
  return Effect.gen(function* () {
    const clock = yield* configLock(sql, owner);

    const records = [
      ...(yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
      AND kind IN ('instruction','skill','marketplace','plugin')`),
    ];

    const documents = yield* sql<Stamped & { document: JsonValue }>`SELECT id::text,document,updated_at
      FROM instruction_documents WHERE owner_user_id=${owner}::uuid ORDER BY id`;

    const skills = yield* sql<Stamped & { definition: JsonValue }>`SELECT id::text,definition,updated_at
      FROM agent_skills WHERE owner_user_id=${owner}::uuid ORDER BY id`;

    const skillVersions = yield* sql<VersionRow>`SELECT skill_id::text AS item,version::text,content_hash,
      source_commit AS commit,COALESCE(artifact->>'checksum','') AS checksum FROM agent_skill_versions
      WHERE owner_user_id=${owner}::uuid`;

    const markets = yield* sql<Stamped & { marketplace: JsonValue; hash: string }>`SELECT id::text,
      marketplace - 'plugins' AS marketplace,config_content_hash(COALESCE(marketplace->'plugins','[]')) AS hash,
      updated_at FROM agent_marketplaces WHERE owner_user_id=${owner}::uuid ORDER BY id`;

    const plugins = yield* sql<Stamped & { plugin: JsonValue; name: string }>`SELECT id::text,
      plugin #- '{assignment,artifact}' AS plugin,COALESCE(plugin->'assignment'->'artifact'->>'name','') AS name,
      updated_at FROM agent_plugins WHERE owner_user_id=${owner}::uuid ORDER BY id`;

    const pluginVersions = yield* sql<VersionRow>`SELECT plugin_id::text AS item,version::text,content_hash,
      COALESCE(plugin->>'commit','') AS commit,COALESCE(plugin->'assignment'->'artifact'->>'checksum','') AS checksum
      FROM agent_plugin_versions WHERE owner_user_id=${owner}::uuid`;

    const { recordFor, update, finish } = projectWriter(sql, owner, node, records, clock.hlc, environmentManaged);

    for (const row of documents) {
      const doc = fromJson(ui.InstructionDocumentSchema, row.document, options);
      yield* update(
        recordFor("instruction", row.id, row.id),
        {
          name: doc.name,
          harness: doc.harness,
          selector: doc.selector ? toJson(ui.EnvironmentSelectorSchema, doc.selector) : null,
          fragments: doc.fragments.map((f) => toJson(ui.InstructionFragmentSchema, f)),
          deviceHome: doc.deviceHome,
          platformHome: doc.platformHome,
        },
        row.updated_at,
      );
    }

    for (const row of skills) {
      const skill = fromJson(ui.LibrarySkillSchema, row.definition, options);
      const source = skill.source;
      yield* update(
        recordFor("skill", row.id, row.id),
        {
          name: skill.name,
          ...assignment(skill),
          source: source
            ? { url: source.url, ref: source.ref, path: source.path, credentialAccountId: source.credentialAccountId }
            : null,
          autoUpdate: source?.autoUpdate ?? false,
          pinned: source?.pinned ?? false,
          ...versionValues(skillVersions, row.id, skill.version),
        },
        row.updated_at,
      );
    }

    for (const row of markets) {
      const market = fromJson(ui.EnvironmentMarketplaceSchema, row.marketplace, options);
      const source = market.source;
      yield* update(
        recordFor("marketplace", row.id, row.id),
        {
          name: market.name,
          source: source
            ? { url: source.url, ref: source.ref, path: source.path, credentialAccountId: source.credentialAccountId }
            : null,
          catalog: { hash: row.hash, commit: source?.commit ?? "" },
        },
        row.updated_at,
      );
    }

    const marketGlobal = (local: string) =>
      records.find((r) => r.kind === "marketplace" && r.local_id === local)?.global_id ?? local;

    for (const row of plugins) {
      const plugin = fromJson(ui.LibraryPluginSchema, row.plugin, options);
      const item = plugin.assignment;

      if (!item) continue;
      yield* update(
        recordFor("plugin", row.id, row.id),
        {
          name: row.name,
          marketplace: marketGlobal(plugin.marketplaceId),
          ...assignment(item),
          ...versionValues(pluginVersions, row.id, item.version),
        },
        row.updated_at,
      );
    }

    yield* finish();
  });
}
