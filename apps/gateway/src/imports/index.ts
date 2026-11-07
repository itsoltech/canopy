import { create } from "@bufbuild/protobuf";
import { timestampFromMs, timestampMs } from "@bufbuild/protobuf/wkt";
import { ui, type ImportScan } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "../core/core.ts";
import { coreState, InvalidError, UnavailableError } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { coreWorkers } from "../core/core-providers.ts";
import {
  byActivity,
  candidate,
  estimatedBytes,
  groups,
  matches,
  type CandidateContext,
  type KnownSource,
  type WorkspaceRow,
} from "./candidates.ts";

/** Capability of workers that can scan and read CLI homes (docs/import.md). */
export const CLI_IMPORT = "cli_import_v1";

const SCAN_TTL_MS = 30 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SCANS = 8;
const SCAN_TIMEOUT_MS = 120_000;

interface StoredScan {
  readonly id: string;
  readonly workerId: string;
  readonly os: string;
  readonly at: number;
  readonly scan: ImportScan;
}

/**
 * Settings → Import on the gateway (docs/import.md): scans run on the owner's own workers of this computer; results
 * live in memory for 30 minutes and are listed with filters, directory groups and suggested projects.
 */
export class CliImports {
  readonly #core: GatewayCore;
  readonly #scans = new Map<string, StoredScan>();

  constructor(core: GatewayCore) {
    this.#core = core;
  }

  get #userId(): string {
    return this.#core[coreState].options.userId;
  }

  sql<A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>): Promise<A> {
    return this.#core[coreState].actions.run(Effect.flatMap(SqlClient.SqlClient, use));
  }

  /** The owner's worker on this computer that can import; otherwise an error the page shows as it is. */
  async worker(workerId: string): Promise<ui.Worker> {
    const userId = this.#userId;

    if (!UUID.test(workerId)) throw new InvalidError("Worker not found");

    // Only the owner's own workers: a shared worker reads someone else's CLI homes.
    const owned = await this.sql(
      (sql) => sql`SELECT 1 FROM workers WHERE id = ${workerId}::uuid AND owner_user_id = ${userId}::uuid
                     AND archived_at IS NULL AND revoked_at IS NULL`,
    );

    const worker = owned.length > 0 ? (await coreWorkers(this.#core)).find((w) => w.id === workerId) : undefined;

    if (!worker) throw new InvalidError("Worker not found");

    if (!worker.online) throw new UnavailableError(`${worker.name} is offline. Start it, then scan again.`);
    const connection = this.#core.link.connections.get(workerId);

    if (!connection?.hello.capabilities.includes(CLI_IMPORT))
      throw new UnavailableError(`Update the worker on ${worker.name} to import its data.`);

    return worker;
  }

  async scan(request: ui.ScanImportRequest): Promise<ui.ScanImportResponse> {
    const worker = await this.worker(request.workerId);

    const result = await coreWorkerQuery(
      this.#core,
      worker.id,
      { case: "scanImportSources", value: { agentClis: [] } },
      SCAN_TIMEOUT_MS,
    );

    if (!result.importScan) throw new UnavailableError("The worker did not return a scan");
    const id = crypto.randomUUID();
    this.#prune();
    this.#scans.set(id, { id, workerId: worker.id, os: worker.os, at: Date.now(), scan: result.importScan });

    return create(ui.ScanImportResponseSchema, {
      scanId: id,
      workerId: worker.id,
      overview: overview(result.importScan),
      truncated: result.importScan.truncated,
      scannedAt: timestampFromMs(Date.now()),
      skipped: result.importScan.skipped,
    });
  }

  /** A scan of this owner's worker, still in memory. */
  stored(scanId: string): StoredScan {
    const stored = this.#scans.get(scanId);

    if (!stored || Date.now() - stored.at > SCAN_TTL_MS) throw new InvalidError("The scan expired. Scan again.");

    return stored;
  }

  async listCandidates(request: ui.ListImportCandidatesRequest): Promise<ui.ListImportCandidatesResponse> {
    const stored = this.stored(request.scanId);
    // Ownership is checked again: the worker may have been removed or given away since the scan.
    await this.worker(stored.workerId);
    const context = await this.context(stored);
    const matching = stored.scan.threads.filter((s) => matches(s, request.filter)).sort(byActivity);
    const limit = Math.min(request.limit || 200, 1000);

    return create(ui.ListImportCandidatesResponseSchema, {
      candidates: matching.slice(request.offset, request.offset + limit).map((s) => candidate(s, context)),
      total: matching.length,
      totalBytes: matching.reduce((sum, s) => sum + s.bytes, 0n),
      groups: groups(matching, context),
      estimatedBytes: estimatedBytes(matching),
    });
  }

  async context(stored: StoredScan): Promise<CandidateContext> {
    const userId = this.#userId;
    const workerId = stored.workerId;

    const [workspaces, threads] = await this.sql((sql) =>
      Effect.all([
        sql<WorkspaceRow>`
          SELECT pw.id, pw.project_id, p.name AS project_name, pw.root_path
            FROM project_workspaces pw JOIN projects p ON p.id = pw.project_id
           WHERE pw.worker_id = ${workerId}::uuid AND p.owner_user_id = ${userId}::uuid
             AND p.archived_at IS NULL AND pw.archived_at IS NULL AND p.kind <> 'scratch'`,
        sql<{ id: string; provider: string; provider_thread_id: string }>`
          SELECT id, provider, provider_thread_id FROM threads
           WHERE worker_id = ${workerId}::uuid AND owner_user_id = ${userId}::uuid
             AND provider_thread_id IS NOT NULL AND deleted_at IS NULL`,
      ]),
    );

    const known = new Map<string, KnownSource>();

    for (const t of threads)
      known.set(`${t.provider}:${t.provider_thread_id}`, { threadId: t.id, status: "in_canopy" });

    return { os: stored.os, workspaces, known };
  }

  #prune(): void {
    for (const [id, stored] of this.#scans) if (Date.now() - stored.at > SCAN_TTL_MS) this.#scans.delete(id);

    while (this.#scans.size >= MAX_SCANS) this.#scans.delete(this.#scans.keys().next().value!);
  }
}

function overview(scan: ImportScan): ui.ImportOverview[] {
  return scan.roots.map((root) => {
    const threads = scan.threads.filter((t) => t.rootId === root.id && root.id && !t.subagent);
    const times = threads.flatMap((t) => (t.updatedAt ? [timestampMs(t.updatedAt)] : []));

    return create(ui.ImportOverviewSchema, {
      agentCli: root.agentCli,
      threads: threads.length,
      bytes: threads.reduce((sum, t) => sum + t.bytes, 0n),
      ...(times.length > 0 && {
        oldest: timestampFromMs(Math.min(...times)),
        newest: timestampFromMs(Math.max(...times)),
      }),
      directories: new Set(threads.map((t) => t.cwd)).size,
      rootPath: root.path,
      cliVersion: root.cliVersion,
      problem: root.problem,
    });
  });
}
