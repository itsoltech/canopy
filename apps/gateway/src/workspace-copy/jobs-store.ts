import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { z } from "zod";

/** Statuses that a runner continues after a restart. */
export const OPEN_STATUSES = ["queued", "copying", "finishing", "waiting"] as const;

export type JobStatus = (typeof OPEN_STATUSES)[number] | "completed" | "failed" | "cancelled";

const rowSchema = z.object({
  id: z.string(),
  source_ref: z.string(),
  target_ref: z.string(),
  project_ref: z.string(),
  parent_path: z.string(),
  name: z.string(),
  target_name: z.string(),
  ignored_hashes: z.array(z.string()),
  secret_hashes: z.array(z.string()),
  status: z.enum([...OPEN_STATUSES, "completed", "failed", "cancelled"]),
  bytes: z.coerce.bigint(),
  total_bytes: z.coerce.bigint(),
  files: z.number(),
  total_files: z.number(),
  skipped: z.number(),
  workspace_ref: z.string(),
  error: z.string(),
  created_ms: z.coerce.number(),
  updated_ms: z.coerce.number(),
});

export type JobRow = z.infer<typeof rowSchema>;

export interface NewJob {
  id: string;
  sourceRef: string;
  targetRef: string;
  projectRef: string;
  parentPath: string;
  name: string;
  targetName: string;
  ignoredHashes: string[];
  secretHashes: string[];
}

export interface JobProgress {
  bytes: bigint;
  totalBytes: bigint;
  files: number;
  totalFiles: number;
  skipped: number;
}

const COLUMNS = `id::text, source_ref, target_ref, project_ref, parent_path, name, target_name, ignored_hashes,
  secret_hashes, status, bytes::text, total_bytes::text, files, total_files, skipped, workspace_ref, error,
  (extract(epoch from created_at) * 1000)::bigint::text AS created_ms,
  (extract(epoch from updated_at) * 1000)::bigint::text AS updated_ms`;

type Run = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) => Promise<A>;

/** Every query is scoped to the gateway's owner; another owner's job is simply not found. */
export class CopyJobStore {
  constructor(
    private readonly run: Run,
    private readonly owner: () => string,
  ) {}

  async insert(job: NewJob) {
    await this.run(
      (sql) => sql`
      INSERT INTO workspace_copy_jobs (id, owner_user_id, source_ref, target_ref, project_ref, parent_path, name,
        target_name, ignored_hashes, secret_hashes)
      VALUES (${job.id}::uuid, ${this.owner()}::uuid, ${job.sourceRef}, ${job.targetRef}, ${job.projectRef},
        ${job.parentPath}, ${job.name}, ${job.targetName}, ${JSON.stringify(job.ignoredHashes)}::jsonb,
        ${JSON.stringify(job.secretHashes)}::jsonb)
      ON CONFLICT (id) DO NOTHING`,
    );
  }

  async get(id: string): Promise<JobRow | undefined> {
    if (!z.uuid().safeParse(id).success) return undefined;

    const rows = await this.run(
      (sql) =>
        sql`SELECT ${sql.literal(COLUMNS)} FROM workspace_copy_jobs WHERE id=${id}::uuid AND owner_user_id=${this.owner()}::uuid`,
    );

    return rows[0] ? rowSchema.parse(rows[0]) : undefined;
  }

  /** Open jobs first, then the finished ones of the last day; at most 50. */
  async list(): Promise<JobRow[]> {
    const rows = await this.run(
      (sql) => sql`
      SELECT ${sql.literal(COLUMNS)} FROM workspace_copy_jobs
       WHERE owner_user_id=${this.owner()}::uuid
         AND (status IN ('queued','copying','finishing','waiting','failed') OR updated_at > now() - interval '1 day')
       ORDER BY created_at DESC LIMIT 50`,
    );

    return rows.map((row) => rowSchema.parse(row));
  }

  async open(): Promise<JobRow[]> {
    const rows = await this.run(
      (sql) => sql`
      SELECT ${sql.literal(COLUMNS)} FROM workspace_copy_jobs
       WHERE owner_user_id=${this.owner()}::uuid AND status IN ('queued','copying','finishing','waiting')
       ORDER BY created_at`,
    );

    return rows.map((row) => rowSchema.parse(row));
  }

  /** A status change that only applies from `from` (when given); returns whether it applied. */
  async status(
    id: string,
    status: JobStatus,
    details: { error?: string; workspaceRef?: string; from?: JobStatus[] } = {},
  ) {
    const from = details.from?.join(",") ?? null;

    const rows = await this.run(
      (sql) => sql`
      UPDATE workspace_copy_jobs SET status=${status}, error=${details.error ?? ""},
        workspace_ref=CASE WHEN ${details.workspaceRef ?? ""}='' THEN workspace_ref ELSE ${details.workspaceRef ?? ""} END,
        updated_at=now()
       WHERE id=${id}::uuid AND owner_user_id=${this.owner()}::uuid
         AND (${from}::text IS NULL OR status = ANY(string_to_array(${from}::text, ',')))
       RETURNING id`,
    );

    return rows.length > 0;
  }

  async progress(id: string, progress: JobProgress) {
    await this.run(
      (sql) => sql`
      UPDATE workspace_copy_jobs SET bytes=${progress.bytes.toString()}::bigint,
        total_bytes=${progress.totalBytes.toString()}::bigint, files=${progress.files}, total_files=${progress.totalFiles},
        skipped=${progress.skipped}, updated_at=now()
       WHERE id=${id}::uuid AND owner_user_id=${this.owner()}::uuid`,
    );
  }

  async remove(id: string) {
    const rows = await this.run(
      (sql) => sql`
      DELETE FROM workspace_copy_jobs WHERE id=${id}::uuid AND owner_user_id=${this.owner()}::uuid
        AND status IN ('completed','failed','cancelled') RETURNING id`,
    );

    return rows.length > 0;
  }

  /** Finished jobs are kept a week for the record; the list shows a day of them. */
  async prune() {
    await this.run(
      (sql) => sql`
      DELETE FROM workspace_copy_jobs WHERE owner_user_id=${this.owner()}::uuid
        AND status IN ('completed','cancelled') AND updated_at < now() - interval '7 days'`,
    );
  }
}

/** The client message: the row, with the live current file of a running job. */
export function jobMessage(row: JobRow, currentFile = "") {
  return create(ui.WorkspaceCopyJobSchema, {
    id: row.id,
    sourceRef: row.source_ref,
    targetRef: row.target_ref,
    projectRef: row.project_ref,
    name: row.name,
    targetName: row.target_name,
    parentPath: row.parent_path,
    status: row.status,
    progress: {
      bytes: row.bytes,
      totalBytes: row.total_bytes,
      files: row.files,
      totalFiles: row.total_files,
      currentFile,
      status: row.status,
      workspaceRef: row.workspace_ref,
      skipped: row.skipped,
    },
    error: row.error,
    createdMs: BigInt(row.created_ms),
    updatedMs: BigInt(row.updated_ms),
  });
}
