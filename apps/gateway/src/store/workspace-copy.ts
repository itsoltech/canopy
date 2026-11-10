import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { z } from "zod";
import { NotFound } from "./errors.ts";

export interface WorkspaceCopyRow {
  id: string;
  owner_user_id: string;
  project_id: string;
  worker_id: string;
  source_ref: string;
  file_count: number;
  byte_count: string;
  status: string;
  directory: string;
  workspace_id: string | null;
}

export function workspaceCopyStore(sql: SqlClient.SqlClient) {
  return {
    copyPreset: (owner: string, project: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ included: string[]; excluded: string[] }>`
        SELECT included, excluded FROM workspace_copy_presets WHERE owner_user_id=${owner}::uuid AND project_id=${project}::uuid`;

        return {
          included: z.array(z.string()).parse(rows[0]?.included ?? []),
          excluded: z.array(z.string()).parse(rows[0]?.excluded ?? []),
        };
      }),
    saveCopyPreset: (owner: string, project: string, included: string[], excluded: string[]) =>
      sql`
      INSERT INTO workspace_copy_presets (owner_user_id, project_id, included, excluded)
      SELECT ${owner}::uuid, id, ${JSON.stringify(included)}::jsonb, ${JSON.stringify(excluded)}::jsonb FROM projects WHERE id=${project}::uuid AND owner_user_id=${owner}::uuid
      ON CONFLICT (owner_user_id, project_id) DO UPDATE SET included=EXCLUDED.included, excluded=EXCLUDED.excluded, updated_at=now()`.pipe(
        Effect.asVoid,
      ),
    copyJob: (owner: string, token: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<WorkspaceCopyRow>`SELECT * FROM workspace_copies WHERE id=${token}::uuid AND owner_user_id=${owner}::uuid`;

        if (!rows[0]) return yield* Effect.fail(new NotFound("copy not found"));

        return rows[0];
      }),
    createCopyJob: (
      owner: string,
      token: string,
      project: string,
      worker: string,
      source: string,
      count: number,
      bytes: bigint,
    ) =>
      sql`
      INSERT INTO workspace_copies (id, owner_user_id, project_id, worker_id, source_ref, file_count, byte_count)
      SELECT ${token}::uuid, ${owner}::uuid, id, ${worker}::uuid, ${source}, ${count}, ${bytes.toString()}::bigint
      FROM projects WHERE id=${project}::uuid AND owner_user_id=${owner}::uuid
      ON CONFLICT (id) DO NOTHING`.pipe(Effect.asVoid),
    updateCopyJob: (owner: string, token: string, status: string, directory = "", workspace = "") =>
      sql`
      UPDATE workspace_copies SET status=${status}, directory=CASE WHEN ${directory}='' THEN directory ELSE ${directory} END,
        workspace_id=COALESCE(NULLIF(${workspace},'')::uuid, workspace_id), updated_at=now()
      WHERE id=${token}::uuid AND owner_user_id=${owner}::uuid`.pipe(Effect.asVoid),
    auditCopy: (owner: string, token: string, action: string) =>
      sql`
      INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details)
      SELECT ${Bun.randomUUIDv7()}::uuid, ${owner}::uuid, ${action}, 'workspace_copy', id,
        jsonb_build_object('source',source_ref,'worker',worker_id,'files',file_count,'bytes',byte_count)
      FROM workspace_copies WHERE id=${token}::uuid AND owner_user_id=${owner}::uuid`.pipe(Effect.asVoid),
  };
}
