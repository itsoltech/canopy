import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { SkillArtifactSchema, ui, type SkillArtifact } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

export function skills(sql: SqlClient.SqlClient, owner: string) {
  return sql<{ definition: JsonValue; artifact: JsonValue; versions: string[]; source_commit: string }>`
    SELECT s.definition, v.artifact, v.source_commit,
      ARRAY(SELECT version::text FROM agent_skill_versions h
        WHERE h.skill_id = s.id AND h.owner_user_id = s.owner_user_id ORDER BY version) AS versions
    FROM agent_skills s JOIN agent_skill_versions v ON v.skill_id = s.id AND v.owner_user_id = s.owner_user_id
      AND v.version = (s.definition->>'version')::bigint
    WHERE s.owner_user_id = ${owner}::uuid ORDER BY s.created_at, s.id`.pipe(
    Effect.map((rows) =>
      rows.map((row) => {
        const definition = fromJson(ui.LibrarySkillSchema, row.definition);

        return create(ui.LibrarySkillSchema, {
          ...definition,
          ...(definition.source && { source: { ...definition.source, commit: row.source_commit } }),
          artifact: fromJson(SkillArtifactSchema, row.artifact),
          versions: row.versions.map(BigInt),
        });
      }),
    ),
  );
}

export function skillVersion(sql: SqlClient.SqlClient, owner: string, id: string, version: bigint) {
  return Effect.gen(function* () {
    const rows = yield* sql<{ artifact: JsonValue }>`SELECT artifact FROM agent_skill_versions
      WHERE skill_id = ${id}::uuid AND owner_user_id = ${owner}::uuid AND version = ${version}`;

    if (!rows[0]) return yield* Effect.fail(new ConnectError("Skill version not found.", Code.NotFound));

    return fromJson(SkillArtifactSchema, rows[0].artifact);
  });
}

/** Historical pins only; current artifacts already belong to the owner-scoped library snapshot. */
export function skillVersions(
  sql: SqlClient.SqlClient,
  owner: string,
  refs: readonly { id: string; version: bigint }[],
) {
  if (!refs.length) return Effect.succeed(new Map<string, SkillArtifact>());
  const wanted = JSON.stringify(refs.map((ref) => ({ id: ref.id, version: ref.version.toString() })));

  return sql<{ skill_id: string; version: bigint; artifact: JsonValue }>`SELECT v.skill_id,v.version,v.artifact
    FROM agent_skill_versions v JOIN jsonb_to_recordset(${wanted}::jsonb) AS r(id uuid,version bigint)
      ON v.skill_id=r.id AND v.version=r.version WHERE v.owner_user_id=${owner}::uuid`.pipe(
    Effect.map(
      (rows) =>
        new Map(rows.map((row) => [`${row.skill_id}:${row.version}`, fromJson(SkillArtifactSchema, row.artifact)])),
    ),
  );
}

export function addSkillVersion(
  sql: SqlClient.SqlClient,
  owner: string,
  id: string,
  version: bigint,
  artifact: SkillArtifact,
  commit = "",
) {
  const json = JSON.stringify(toJson(SkillArtifactSchema, artifact));

  return sql`INSERT INTO agent_skill_versions(skill_id, owner_user_id, version, artifact, source_commit)
    VALUES (${id}::uuid, ${owner}::uuid, ${version}, ${json}::jsonb, ${commit})`;
}

export function saveSkillDefinition(sql: SqlClient.SqlClient, owner: string, skill: ui.LibrarySkill) {
  const definition = create(ui.LibrarySkillSchema, { ...skill, artifact: undefined, versions: [] });
  const json = JSON.stringify(toJson(ui.LibrarySkillSchema, definition));

  return sql`INSERT INTO agent_skills(id, owner_user_id, definition) VALUES (${skill.id}::uuid, ${owner}::uuid, ${json}::jsonb)
    ON CONFLICT(id) DO UPDATE SET definition = EXCLUDED.definition, updated_at = now() WHERE agent_skills.owner_user_id = ${owner}::uuid`;
}
