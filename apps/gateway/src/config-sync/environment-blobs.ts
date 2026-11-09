import { fromJson } from "@bufbuild/protobuf";
import { SkillArtifactSchema, ui, type SkillArtifact } from "@canopy/contracts";
import { validatePluginFiles } from "@canopy/domain/plugin-artifact";
import { skillDigest, validateSkillFiles } from "@canopy/domain/skill-artifact";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { HASH } from "./environment-values.ts";

/**
 * Library content travels apart from the records (docs/linked-computers.md, "Treść biblioteki"). A record names
 * each version by the SHA-256 of its JSON text; a receiver fetches what it lacks from the sending computer,
 * checks the hash and the artifact, and stores the same text, so its own hash of it is the same.
 */

export type Blobs = ReadonlyMap<string, Uint8Array>;

/** Encoded skill artifacts reach about 34 MiB; catalogs carry several plugins. */
export const BLOB_BYTES = 128 * 1024 * 1024;
export const BLOB_CHUNK = 4 * 1024 * 1024;

/** This owner's content with this hash, from any library table. */
export function localBlob(sql: SqlClient.SqlClient, owner: string, hash: string) {
  if (!HASH.test(hash)) return Effect.succeed(undefined);

  return Effect.map(
    sql<{ content: Uint8Array }>`SELECT content FROM (
      SELECT convert_to(artifact::text,'UTF8') AS content FROM agent_skill_versions
        WHERE owner_user_id=${owner}::uuid AND content_hash=${hash}
      UNION ALL SELECT convert_to((plugin->'assignment'->'artifact')::text,'UTF8') FROM agent_plugin_versions
        WHERE owner_user_id=${owner}::uuid AND content_hash=${hash}
      UNION ALL SELECT convert_to(plugins::text,'UTF8') FROM agent_marketplace_catalogs
        WHERE owner_user_id=${owner}::uuid AND content_hash=${hash}) found LIMIT 1`,
    (rows) => rows[0]?.content,
  );
}

/** Metadata only: an absent version must not cause a content lookup for each record that names it. */
export function presentBlobHashes(sql: SqlClient.SqlClient, owner: string, hashes: readonly string[]) {
  if (!hashes.length) return Effect.succeed(new Set<string>());

  return Effect.map(
    sql<{ hash: string }>`SELECT content_hash AS hash FROM agent_skill_versions
    WHERE owner_user_id=${owner}::uuid AND content_hash=ANY(${hashes}::text[])
    UNION SELECT content_hash FROM agent_plugin_versions
    WHERE owner_user_id=${owner}::uuid AND content_hash=ANY(${hashes}::text[])
    UNION SELECT content_hash FROM agent_marketplace_catalogs
    WHERE owner_user_id=${owner}::uuid AND content_hash=ANY(${hashes}::text[])`,
    (rows) => new Set(rows.map((row) => row.hash)),
  );
}

/** Content that live records name and no library table here has yet. */
export function missingBlobs(sql: SqlClient.SqlClient, owner: string) {
  return Effect.map(
    sql<{ hash: string }>`WITH records AS MATERIALIZED (
      SELECT kind,fields FROM config_items WHERE owner_user_id=${owner}::uuid
        AND kind IN ('skill','marketplace','plugin') AND home_node_id=''
        AND (deleted->'value' IS DISTINCT FROM 'true'::jsonb OR fields<>'{}'::jsonb)
    ), wanted AS MATERIALIZED (
      SELECT DISTINCT hash FROM (
        SELECT substring(key FROM 9) AS hash FROM records,
          LATERAL jsonb_object_keys(fields) AS key
          WHERE kind IN ('skill','plugin') AND length(key)=72 AND starts_with(key,'version.')
        UNION ALL SELECT fields#>>'{catalog,value,hash}' FROM records WHERE kind='marketplace'
          AND jsonb_typeof(fields#>'{catalog,value,hash}')='string'
          AND jsonb_typeof(fields#>'{catalog,value,commit}')='string'
      ) refs
    ) SELECT hash FROM wanted WHERE length(hash)=64 AND translate(hash,'0123456789abcdef','')=''
    AND NOT EXISTS (
      SELECT 1 FROM agent_skill_versions WHERE owner_user_id=${owner}::uuid AND content_hash=wanted.hash
    ) AND NOT EXISTS (
      SELECT 1 FROM agent_plugin_versions WHERE owner_user_id=${owner}::uuid AND content_hash=wanted.hash
    ) AND NOT EXISTS (
      SELECT 1 FROM agent_marketplace_catalogs WHERE owner_user_id=${owner}::uuid AND content_hash=wanted.hash
    ) ORDER BY hash`,
    (rows) => rows.map((row) => row.hash),
  );
}

function text(bytes: Uint8Array, hash: string) {
  if (bytes.length > BLOB_BYTES || skillDigest(bytes) !== hash) throw new Error("Content does not match its hash");

  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The artifact exactly as sent, checked again like an upload. Undefined: the content is not valid here. */
export function verifiedArtifact(bytes: Uint8Array, hash: string, checksum: string, plugin: boolean) {
  try {
    const json = text(bytes, hash);
    const artifact: SkillArtifact = fromJson(SkillArtifactSchema, JSON.parse(json));
    const checked = plugin ? validatePluginFiles(artifact.files) : validateSkillFiles(artifact.files);

    if (checked.checksum !== artifact.checksum || artifact.checksum !== checksum) return undefined;

    return { json, artifact };
  } catch {
    return undefined;
  }
}

/** A frozen catalog: every plugin bundle it offers is checked like a discovered one. */
export function verifiedCatalog(bytes: Uint8Array, hash: string) {
  try {
    const json = text(bytes, hash);
    const parsed: unknown = JSON.parse(json);

    if (!Array.isArray(parsed)) return undefined;
    const plugins = parsed.map((p) => fromJson(ui.MarketplacePluginSchema, p));

    for (const p of plugins) {
      if (!p.artifact?.files.length) continue;

      if (validatePluginFiles(p.artifact.files).checksum !== p.artifact.checksum) return undefined;
    }

    return { json, plugins };
  } catch {
    return undefined;
  }
}
