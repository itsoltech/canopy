import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { AgentEnvironmentReportSchema, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect, Result } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";
import { environmentTransaction } from "../config-sync/environment-records.ts";

export function documents(sql: SqlClient.SqlClient, owner: string) {
  return sql<{
    document: JsonValue;
  }>`SELECT document FROM instruction_documents WHERE owner_user_id = ${owner}::uuid ORDER BY created_at, id`.pipe(
    Effect.map((rows) => rows.map((r) => fromJson(ui.InstructionDocumentSchema, r.document))),
  );
}

export function workers(sql: SqlClient.SqlClient, owner: string) {
  return sql<{
    id: string;
    name: string;
    automatic_tags: string[] | null;
    manual_tags: string[] | null;
    supported: boolean | null;
    skills_supported: boolean | null;
    plugins_supported: boolean | null;
    report: JsonValue | null;
  }>`SELECT w.id, w.name, e.automatic_tags, e.manual_tags, e.supported, e.skills_supported, e.plugins_supported, e.report
     FROM workers w LEFT JOIN worker_environments e ON e.worker_id = w.id
     WHERE w.owner_user_id = ${owner}::uuid AND w.archived_at IS NULL AND w.revoked_at IS NULL ORDER BY w.name, w.id`.pipe(
    Effect.map((rows) =>
      rows.map((w) =>
        create(ui.EnvironmentWorkerSchema, {
          workerId: w.id,
          name: w.name,
          automaticTags: w.automatic_tags ?? [],
          manualTags: w.manual_tags ?? [],
          supported: w.supported ?? false,
          skillsSupported: w.skills_supported ?? false,
          pluginsSupported: w.plugins_supported ?? false,
          ...(w.report && { report: fromJson(AgentEnvironmentReportSchema, w.report) }),
        }),
      ),
    ),
  );
}

export function revision(sql: SqlClient.SqlClient, owner: string) {
  return sql<{ revision: bigint }>`SELECT revision FROM agent_environments WHERE owner_user_id = ${owner}::uuid`.pipe(
    Effect.map((rows) => BigInt(rows[0]?.revision ?? 0)),
  );
}

export function saveDocument(sql: SqlClient.SqlClient, owner: string, document: ui.InstructionDocument) {
  const json = JSON.stringify(toJson(ui.InstructionDocumentSchema, document));

  return Effect.gen(function* () {
    yield* sql`INSERT INTO instruction_documents (id, owner_user_id, revision, document)
      VALUES (${document.id}::uuid, ${owner}::uuid, ${document.revision}, ${json}::jsonb)
      ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision, document = EXCLUDED.document, updated_at = now()
      WHERE instruction_documents.owner_user_id = ${owner}::uuid`;
    yield* sql`INSERT INTO instruction_document_versions (document_id, owner_user_id, revision, document)
      VALUES (${document.id}::uuid, ${owner}::uuid, ${document.revision}, ${json}::jsonb)`;
  });
}

export function audit(sql: SqlClient.SqlClient, owner: string, action: string, entityId: string) {
  return sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details)
    VALUES (${Bun.randomUUIDv7()}::uuid, ${owner}::uuid, ${action}, 'agent_environment', ${entityId}::uuid, '{}'::jsonb)`;
}

/** Typed failures cross the Effect boundary without exposing SQL or instruction text in diagnostics. */
export class EnvironmentDatabase {
  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
  ) {}

  async run<A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> {
    const result = await this.runtime.runPromise(Effect.result(effect));

    if (Result.isFailure(result)) {
      if (result.failure instanceof ConnectError) throw result.failure;
      throw new ConnectError("Environment operation failed. Refresh and try again.", Code.Internal);
    }

    return result.success;
  }

  /** `receipt` runs last in the same transaction (an import records what it changed, docs/import.md "Blokady"). */
  mutate<A, E>(
    expected: bigint,
    action: (sql: SqlClient.SqlClient, next: bigint) => Effect.Effect<A, E, SqlClient.SqlClient>,
    receipt?: (sql: SqlClient.SqlClient) => Effect.Effect<void>,
  ): Promise<A> {
    const owner = this.owner;

    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // The library is shared configuration: versions are recorded in the same transaction (environmentTransaction).
        return yield* environmentTransaction(
          sql,
          Effect.gen(function* () {
            yield* sql`INSERT INTO agent_environments (owner_user_id) VALUES (${owner}::uuid) ON CONFLICT DO NOTHING`;

            const rows = yield* sql<{
              revision: bigint;
            }>`SELECT revision FROM agent_environments WHERE owner_user_id = ${owner}::uuid FOR UPDATE`;

            const current = BigInt(rows[0]?.revision ?? 0);

            if (current !== expected)
              return yield* Effect.fail(
                new ConnectError("Environment changed. Refresh before saving.", Code.FailedPrecondition),
              );
            const next = current + 1n;
            const result = yield* action(sql, next);
            yield* sql`UPDATE agent_environments SET revision = ${next} WHERE owner_user_id = ${owner}::uuid`;

            if (receipt) yield* receipt(sql);

            return result;
          }),
        );
      }),
    );
  }
}
