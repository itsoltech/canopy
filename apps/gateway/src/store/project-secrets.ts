import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { PROJECT_SECRET_MAX_BYTES, PROJECT_SECRET_NAME_PATTERN } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { isUuid } from "./agent-bus-queries.ts";
import { Invalid, NotFound } from "./errors.ts";
import { encryptSecret, SECRETS_KEY_ID } from "./secrets.ts";

type ProjectSecretMetadata = { name: string; updated_at: Date };

function toProjectSecret(row: ProjectSecretMetadata) {
  return create(ui.ProjectSecretSchema, { name: row.name, updatedAt: timestampFromDate(new Date(row.updated_at)) });
}

function ownedProject(sql: SqlClient.SqlClient, owner: string, projectId: string) {
  return Effect.gen(function* () {
    if (!isUuid(projectId)) return yield* Effect.fail(new Invalid("invalid project ID"));

    const rows = yield* sql`SELECT id FROM projects
      WHERE id=${projectId}::uuid AND owner_user_id=${owner}::uuid AND kind='project' AND archived_at IS NULL
      FOR SHARE`;

    if (!rows.length) return yield* Effect.fail(new NotFound("project not found"));
  });
}

function audit(sql: SqlClient.SqlClient, owner: string, projectId: string, name: string, action: string) {
  return sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
    VALUES (${Bun.randomUUIDv7()}::uuid,${owner}::uuid,${action},'project',${projectId}::uuid,
      jsonb_build_object('name',${name}::text))`;
}

function validateName(name: string) {
  return PROJECT_SECRET_NAME_PATTERN.test(name)
    ? Effect.void
    : Effect.fail(
        new Invalid(
          "use a secret name of up to 128 letters, digits or underscores, starting with a letter or underscore",
        ),
      );
}

export function projectSecretsStore(sql: SqlClient.SqlClient, key: Buffer) {
  return {
    listProjectSecrets: (owner: string, projectId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* ownedProject(sql, owner, projectId);

          const rows = yield* sql<ProjectSecretMetadata>`SELECT name,updated_at FROM project_secrets
            WHERE project_id=${projectId}::uuid ORDER BY name`;

          return rows.map(toProjectSecret);
        }),
      ),
    putProjectSecret: (owner: string, projectId: string, name: string, value: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* validateName(name);

          if (!value || Buffer.byteLength(value, "utf8") > PROJECT_SECRET_MAX_BYTES || value.includes("\0"))
            return yield* Effect.fail(new Invalid("provide a secret of 1–32768 bytes without NUL"));
          yield* ownedProject(sql, owner, projectId);
          const ciphertext = encryptSecret(key, value);

          const rows = yield* sql<ProjectSecretMetadata>`INSERT INTO project_secrets(project_id,name,ciphertext,key_id)
            VALUES (${projectId}::uuid,${name},${ciphertext},${SECRETS_KEY_ID})
            ON CONFLICT(project_id,name) DO UPDATE SET ciphertext=excluded.ciphertext, key_id=excluded.key_id,
              updated_at=statement_timestamp() RETURNING name,updated_at`;

          yield* audit(sql, owner, projectId, name, "put_project_secret");

          return toProjectSecret(rows[0]!);
        }),
      ),
    deleteProjectSecret: (owner: string, projectId: string, name: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* validateName(name);
          yield* ownedProject(sql, owner, projectId);

          const rows = yield* sql`DELETE FROM project_secrets
            WHERE project_id=${projectId}::uuid AND name=${name} RETURNING name`;

          if (rows.length) yield* audit(sql, owner, projectId, name, "delete_project_secret");
        }),
      ),
    projectSecretNames: (owner: string, threadId: string) =>
      sql<{ name: string }>`SELECT s.name FROM project_secrets s
        JOIN projects p ON p.id=s.project_id JOIN threads t ON t.project_id=p.id
        WHERE t.id=${threadId}::uuid AND t.owner_user_id=${owner}::uuid AND p.owner_user_id=t.owner_user_id
          AND p.kind='project' AND p.archived_at IS NULL
          AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.moved_to IS NULL
        ORDER BY s.name`.pipe(Effect.map((rows) => ({ names: rows.map((row) => row.name) }))),
  };
}
