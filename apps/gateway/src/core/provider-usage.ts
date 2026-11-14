import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { Provider, ProviderUsageSnapshotSchema, ui, type ProviderUsageReport } from "@canopy/contracts";
import { sanitizeProviderUsage } from "@canopy/domain/provider-usage";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "./core.ts";
import { coreState } from "./core-context.ts";
import { coreWorkers } from "./core-providers.ts";
import type { WorkerConnection } from "../worker-link/index.ts";
import { queryFamily, queryRpc } from "../diagnostics/query-context.ts";

interface UsageRow {
  worker_id: string;
  provider: number;
  profile_id: string;
  snapshot: JsonValue;
}

/**
 * Persist only typed limit data. Harness rate limits describe a signed-in plan; through a proxy or endpoint the
 * account is unknown, so those instances never store or show them, even if an older worker reports them
 * (docs/provider-accounts.md). Reads and writes enforce the same owner, current configuration and connection.
 */
export class ProviderUsage {
  constructor(readonly core: GatewayCore) {}

  async read() {
    const owner = this.core[coreState].options.userId;

    const rows = await this.core[coreState].actions.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<UsageRow>`SELECT u.* FROM provider_usage u
        JOIN workers w ON w.id=u.worker_id
        JOIN worker_configs c ON c.worker_id=w.id AND c.version=u.config_version
        JOIN provider_instances i ON i.id=u.profile_id
          AND i.harness=CASE u.provider WHEN 1 THEN 'claude' WHEN 2 THEN 'codex' ELSE 'grok' END
        LEFT JOIN provider_instance_workers a ON a.worker_id=w.id AND a.harness=i.harness AND a.instance_id=i.id
        WHERE i.kind='native' AND i.proxy_id IS NULL AND a.proxy_id IS NULL
          AND (w.owner_user_id=${owner}::uuid OR w.owner_user_id IS NULL)
          AND (i.created_by=${owner}::uuid OR i.created_by IS NULL)
          AND w.archived_at IS NULL AND w.revoked_at IS NULL`;
      }).pipe(queryFamily("workers.store"), queryRpc),
    );

    return new Map(
      rows.map((row) => [
        `${row.worker_id}/${row.provider}/${row.profile_id}`,
        sanitizeProviderUsage(fromJson(ProviderUsageSnapshotSchema, row.snapshot, { ignoreUnknownFields: true })),
      ]),
    );
  }

  async decorate(instances: ui.ProviderInstance[]) {
    const usage = await this.read();

    for (const instance of instances)
      for (const worker of instance.workers)
        worker.usage =
          worker.enabled && worker.synced
            ? usage.get(`${worker.workerId}/${instance.harness}/${instance.id}`)
            : undefined;

    return instances;
  }

  async report(connection: WorkerConnection, report: ProviderUsageReport) {
    if (
      !report.snapshot ||
      ![Provider.CLAUDE, Provider.CODEX].includes(report.provider) ||
      !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(report.profileId) ||
      !/^[a-f0-9]{64}$/.test(report.accountKey) ||
      this.core.link.connections.get(connection.workerId) !== connection
    )
      return;
    const snapshot = sanitizeProviderUsage(report.snapshot);

    if (!snapshot.observedAt) return;
    const { workerId } = connection;
    const owner = this.core[coreState].options.userId;
    const harness = report.provider === Provider.CLAUDE ? "claude" : "codex";

    const saved = await this.core[coreState].actions.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql`INSERT INTO provider_usage (worker_id, provider, profile_id, account_key, config_version, snapshot, observed_at)
        SELECT w.id, ${report.provider}, ${report.profileId}, ${report.accountKey}, c.version,
          ${JSON.stringify(toJson(ProviderUsageSnapshotSchema, snapshot))}::jsonb,
          to_timestamp(${Number(snapshot.observedAt!.seconds) + snapshot.observedAt!.nanos / 1e9})
        FROM workers w JOIN worker_configs c ON c.worker_id=w.id
        JOIN provider_instances i ON i.id=${report.profileId} AND i.harness=${harness}
        LEFT JOIN provider_instance_workers a ON a.worker_id=w.id AND a.harness=i.harness AND a.instance_id=i.id
        WHERE w.id=${workerId}::uuid AND c.version=${report.configVersion}
          AND (w.owner_user_id=${owner}::uuid OR w.owner_user_id IS NULL)
          AND (i.created_by=${owner}::uuid OR i.created_by IS NULL)
          AND coalesce(a.enabled, i.all_workers) AND i.kind='native' AND i.proxy_id IS NULL AND a.proxy_id IS NULL AND w.archived_at IS NULL AND w.revoked_at IS NULL
        ON CONFLICT (worker_id, provider, profile_id) DO UPDATE SET
          account_key=EXCLUDED.account_key, config_version=EXCLUDED.config_version,
          snapshot=EXCLUDED.snapshot, observed_at=EXCLUDED.observed_at
        WHERE provider_usage.config_version < EXCLUDED.config_version OR
          (provider_usage.config_version=EXCLUDED.config_version AND provider_usage.observed_at <= EXCLUDED.observed_at)
        RETURNING worker_id`;
      }).pipe(queryFamily("workers.store"), queryRpc),
    );

    if (!saved.length) return;
    const worker = (await coreWorkers(this.core)).find((w) => w.id === workerId);

    if (worker)
      this.core.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "worker", value: worker } }));
  }
}
