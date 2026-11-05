import { clone, create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { SkillArtifactSchema, ui } from "@canopy/contracts";
import { pluginHarnesses } from "@canopy/domain/plugin-components";
import { Effect, Predicate } from "effect";
import type { SqlClient } from "effect/sql";
import { checkSkillAssignment } from "../agent-environment/skill-assignment.ts";
import { savePlugin } from "../agent-environment/plugin-database.ts";
import { equalValue, type ConfigRow } from "./persistence.ts";
import { alive } from "./provider-records.ts";
import { canonicalId, recordOf } from "./provider-apply.ts";
import { valuesOf } from "./provider-values.ts";
import { isCatalog, sourceOf } from "./environment-values.ts";
import { localBlob, verifiedCatalog, type Blobs } from "./environment-blobs.ts";
import { connectorId } from "./connector-apply.ts";
import {
  attempt,
  bumpEnvironment,
  localWorkers,
  named,
  refuse,
  selectorOf,
  storeVersions,
  strings,
  WAITING,
  type LocalVersion,
} from "./environment-support.ts";

const options = { ignoreUnknownFields: true };

type Stored = { item: JsonValue; owner_user_id: string };

/** The marketplace stores the catalog exactly as received, so its hash here is the record's hash. */
export function applyMarketplace(sql: SqlClient.SqlClient, owner: string, row: ConfigRow, blobs: Blobs) {
  return Effect.gen(function* () {
    const stored = (yield* sql<Stored>`SELECT marketplace - 'plugins' AS item,owner_user_id::text
      FROM agent_marketplaces WHERE id=${row.local_id}::uuid`)[0];

    if (stored && stored.owner_user_id !== owner) return refuse(row);

    if (!alive(row)) {
      if (!stored) return false;
      yield* bumpEnvironment(sql, owner);
      yield* sql`DELETE FROM agent_marketplaces WHERE id=${row.local_id}::uuid AND owner_user_id=${owner}::uuid`;

      return true;
    }

    const v = valuesOf(row.fields);
    const catalog = v["catalog"];
    const source = sourceOf(v["source"]);

    if (source) source.credentialAccountId = yield* connectorId(sql, owner, source.credentialAccountId);

    if (!isCatalog(catalog) || !source || !Predicate.isString(v["name"]) || !v["name"]) return refuse(row);

    const taken = yield* sql`SELECT 1 FROM agent_marketplaces WHERE owner_user_id=${owner}::uuid
      AND id<>${row.local_id}::uuid AND marketplace->>'name'=${v["name"]}`;

    if (taken.length) return refuse(row);

    if (
      !(yield* sql`SELECT 1 FROM agent_marketplace_catalogs WHERE owner_user_id=${owner}::uuid
      AND content_hash=${catalog.hash}`).length
    ) {
      const bytes = blobs.get(catalog.hash) ?? (yield* localBlob(sql, owner, catalog.hash));

      if (!bytes) return refuse(row, WAITING);
      const verified = verifiedCatalog(bytes, catalog.hash);

      if (!verified) return refuse(row);
      yield* sql`INSERT INTO agent_marketplace_catalogs(owner_user_id,content_hash,plugins)
        VALUES(${owner}::uuid,${catalog.hash},${verified.json}::jsonb) ON CONFLICT DO NOTHING`;
    }

    const current = stored && fromJson(ui.EnvironmentMarketplaceSchema, stored.item, options);

    const meta = create(ui.EnvironmentMarketplaceSchema, {
      id: row.local_id,
      name: v["name"],
      source: Object.assign(
        current?.source ? clone(ui.SkillSourceSchema, current.source) : create(ui.SkillSourceSchema),
        source,
        { commit: catalog.commit },
      ),
    });

    const same = yield* sql`SELECT 1 FROM agent_marketplaces WHERE id=${row.local_id}::uuid
      AND config_content_hash(COALESCE(marketplace->'plugins','[]'))=${catalog.hash}`;

    if (
      current &&
      same.length &&
      equalValue(toJson(ui.EnvironmentMarketplaceSchema, current), toJson(ui.EnvironmentMarketplaceSchema, meta))
    )
      return false;
    const json = JSON.stringify(toJson(ui.EnvironmentMarketplaceSchema, meta));
    yield* bumpEnvironment(sql, owner);
    yield* sql`INSERT INTO agent_marketplaces (id, owner_user_id, marketplace)
      SELECT ${row.local_id}::uuid, ${owner}::uuid, ${json}::jsonb || jsonb_build_object('plugins',c.plugins)
      FROM agent_marketplace_catalogs c WHERE c.owner_user_id=${owner}::uuid AND c.content_hash=${catalog.hash}
      ON CONFLICT (id) DO UPDATE SET marketplace=EXCLUDED.marketplace, updated_at=now()
      WHERE agent_marketplaces.owner_user_id=${owner}::uuid`;

    return true;
  });
}

/** The selected version's checksum is the owner's consent; the content must match it before workers get it. */
export function applyPlugin(sql: SqlClient.SqlClient, owner: string, row: ConfigRow, blobs: Blobs) {
  return Effect.gen(function* () {
    const stored = (yield* sql<Stored>`SELECT plugin AS item,owner_user_id::text FROM agent_plugins
      WHERE id=${row.local_id}::uuid`)[0];

    if (stored && stored.owner_user_id !== owner) return refuse(row);
    const current = stored && fromJson(ui.LibraryPluginSchema, stored.item, options);

    if (!alive(row)) {
      if (!current) return false;
      yield* bumpEnvironment(sql, owner);
      yield* sql`DELETE FROM agent_plugins WHERE id=${row.local_id}::uuid AND owner_user_id=${owner}::uuid`;

      return true;
    }

    const v = valuesOf(row.fields);
    const name = v["name"];
    const marketId = v["marketplace"];

    if (!Predicate.isString(name) || !Predicate.isString(marketId)) return refuse(row);
    const market = yield* recordOf(sql, owner, "marketplace", yield* canonicalId(sql, owner, "marketplace", marketId));

    const local = market
      ? (yield* sql<{ name: string }>`SELECT marketplace->>'name' AS name FROM agent_marketplaces
          WHERE id::text=${market.local_id} AND owner_user_id=${owner}::uuid`)[0]
      : undefined;

    if (!market || !local) return refuse(row, WAITING);

    const versions = [
      ...(yield* sql<LocalVersion>`SELECT version::text,content_hash,COALESCE(plugin->>'commit','') AS commit
      FROM agent_plugin_versions WHERE plugin_id=${row.local_id}::uuid AND owner_user_id=${owner}::uuid`),
    ];

    const insert = (json: string, number: bigint, commit: string) =>
      sql`INSERT INTO agent_plugin_versions (owner_user_id, plugin_id, version, plugin)
        VALUES (${owner}::uuid, ${row.local_id}::uuid, ${number}, jsonb_build_object('marketplaceId',${market.local_id}::text,
          'marketplaceName',${local.name}::text,'commit',${commit}::text,'assignment',jsonb_build_object('id',${row.local_id}::text,
          'name',${name}::text,'version',${number.toString()}::text,'artifact',${json}::jsonb)))`;

    if (!(yield* storeVersions(sql, owner, v, versions, blobs, insert, true))) return refuse(row);
    const selected = versions.find((l) => l.content_hash === v["selected"]);

    if (!selected) return refuse(row, WAITING);

    const artifact = (yield* sql<{ artifact: JsonValue }>`SELECT plugin->'assignment'->'artifact' AS artifact
      FROM agent_plugin_versions WHERE plugin_id=${row.local_id}::uuid AND owner_user_id=${owner}::uuid
      AND version=${selected.version}::bigint`)[0]!.artifact;

    const workers = yield* localWorkers(sql, owner);

    const parsed = yield* attempt(() => {
      const plugin = create(ui.LibraryPluginSchema, {
        marketplaceId: market.local_id,
        marketplaceName: local.name,
        commit: selected.commit,
        assignment: {
          id: row.local_id,
          name,
          version: BigInt(selected.version),
          versions: versions.map((l) => BigInt(l.version)).sort((a, b) => (a < b ? -1 : 1)),
          harnesses: strings(v["harnesses"]) ?? [],
          selector: selectorOf(v["selector"]),
          overrides: (current?.assignment?.overrides ?? []).filter((o) => !o.version),
          deviceHome: v["deviceHome"] === true,
          platformHome: v["platformHome"] === true,
          artifact: fromJson(SkillArtifactSchema, artifact),
        },
      });

      const item = plugin.assignment!;

      if (
        item.artifact!.name !== name ||
        item.harnesses.some((h) => !pluginHarnesses(item.artifact!.files).includes(h))
      )
        throw new Error("Incompatible plugin");
      checkSkillAssignment(item, workers, named(item.selector));

      return plugin;
    });

    if (!parsed) return refuse(row);
    const plugin = parsed.value;

    if (current && equalValue(toJson(ui.LibraryPluginSchema, current), toJson(ui.LibraryPluginSchema, plugin)))
      return false;
    yield* bumpEnvironment(sql, owner);
    yield* savePlugin(sql, owner, plugin);

    return true;
  });
}
