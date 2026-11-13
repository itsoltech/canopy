import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate, timestampDate } from "@bufbuild/protobuf/wkt";
import { ui, type Provider } from "@canopy/contracts";
import { isCheckInterval, nextUpdateCheck } from "@canopy/domain/update-checks";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { queryFamily, queryRpc } from "../diagnostics/query-context.ts";
import type { CoreRuntime } from "./core.ts";
import { CliLatestSource, KEYS, type CliLatestOptions, type Latest } from "./cli-latest.ts";

interface CheckRow {
  id: string;
  override_minutes: number | null;
  account_minutes: number | null;
  latest: JsonValue | null;
}

/** Latest-version lookups belong to the gateway. Each owner's worker has its own durable snapshot and clock. */
export class CliUpdateChecks {
  readonly #latest = new Map<string, ui.CliLatest[]>();
  #running: Promise<void> | undefined;
  constructor(
    readonly runtime: CoreRuntime,
    readonly userId: string,
    readonly options?: CliLatestOptions,
  ) {}

  rows(workerId = ""): Promise<readonly CheckRow[]> {
    const userId = this.userId;

    return this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<CheckRow>`SELECT w.id, (c.config->>'cliUpdateCheckMinutes')::int AS override_minutes,
        (s.settings#>>'{cliUpdates,intervalMinutes}')::int AS account_minutes,
        w.capabilities->'cliUpdateChecks' AS latest
        FROM workers w LEFT JOIN worker_configs c ON c.worker_id = w.id
        LEFT JOIN user_settings s ON s.user_id = w.owner_user_id
        WHERE w.owner_user_id = ${userId}::uuid AND w.archived_at IS NULL AND w.revoked_at IS NULL
          AND (${workerId} = '' OR w.id::text = ${workerId})`;
      }).pipe(queryFamily("workers.store"), queryRpc),
    );
  }

  async decorate(workers: ui.Worker[]): Promise<void> {
    for (const row of await this.rows()) {
      const worker = workers.find((w) => w.id === row.id);

      if (!worker) continue;
      const latest = this.#read(row);
      worker.cliUpdateCheckMinutes = row.override_minutes ?? undefined;
      worker.effectiveCliUpdateCheckMinutes = row.override_minutes ?? row.account_minutes ?? 360;
      worker.cliUpdatesCheckedAt = latest[0]?.checkedAt;
      const last = worker.cliUpdatesCheckedAt ? timestampDate(worker.cliUpdatesCheckedAt).getTime() : 0;
      const next = nextUpdateCheck(last, worker.effectiveCliUpdateCheckMinutes, Date.now());
      worker.cliUpdatesNextCheckAt = next === undefined ? undefined : timestampFromDate(new Date(next));
    }
  }

  #read(row: CheckRow): ui.CliLatest[] {
    const latest = row.latest ? fromJson(ui.CheckCliUpdatesResponseSchema, row.latest).latest : [];
    this.#latest.set(row.id, latest);

    return latest;
  }

  get(workerId: string, provider: Provider): Latest | undefined {
    const latest = this.#latest.get(workerId)?.find((item) => item.provider === provider);

    return latest
      ? {
          version: latest.version,
          error: latest.error,
          checkedAt: latest.checkedAt ? timestampDate(latest.checkedAt).getTime() : 0,
        }
      : undefined;
  }

  async tick(workerId = "", manual = false, now = Date.now()): Promise<void> {
    // Wait for a concurrent pass, then re-read settings. Manual checks are never swallowed by a timer.
    if (this.#running) {
      await this.#running;

      return this.tick(workerId, manual, now);
    }

    this.#running = this.#check(workerId, manual, now);

    try {
      await this.#running;
    } finally {
      this.#running = undefined;
    }
  }

  async #check(workerId: string, manual: boolean, now: number): Promise<void> {
    const rows = await this.rows(workerId);

    if (workerId && !rows.length) throw new ConnectError("worker not found", Code.NotFound);

    for (const row of rows) {
      const previous = this.#read(row);
      const checked = previous[0]?.checkedAt;
      const last = checked ? timestampDate(checked).getTime() : 0;
      const next = nextUpdateCheck(last, row.override_minutes ?? row.account_minutes ?? 360, now);

      if (!manual && (next === undefined || next > now)) continue;
      const source = new CliLatestSource(this.options);
      await source.refresh();

      const latest = KEYS.map(([, provider]) => {
        const found = source.get(provider);

        return create(ui.CliLatestSchema, {
          provider,
          version: found?.version || previous.find((p) => p.provider === provider)?.version || "",
          error: found?.error ?? "Could not check for updates",
          checkedAt: timestampFromDate(new Date(now)),
        });
      });

      const json = JSON.stringify(
        toJson(ui.CheckCliUpdatesResponseSchema, create(ui.CheckCliUpdatesResponseSchema, { latest })),
      );

      const userId = this.userId;
      await this.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE workers SET capabilities = capabilities || jsonb_build_object('cliUpdateChecks', ${json}::jsonb)
          WHERE id = ${row.id}::uuid AND owner_user_id = ${userId}::uuid`;
        }).pipe(queryFamily("workers.store"), queryRpc),
      );
      this.#latest.set(row.id, latest);
    }
  }

  async setWorker(request: ui.SetWorkerCliUpdateSettingsRequest): Promise<void> {
    const { workerId, intervalMinutes, expectedConfigVersion } = request;

    if (!workerId) throw new ConnectError("worker not found", Code.NotFound);

    if (intervalMinutes !== undefined && !isCheckInterval(intervalMinutes))
      throw new ConnectError("invalid check interval", Code.InvalidArgument);

    if (!(await this.rows(workerId)).length) throw new ConnectError("worker not found", Code.NotFound);
    const userId = this.userId;
    const patch = JSON.stringify(intervalMinutes === undefined ? {} : { cliUpdateCheckMinutes: intervalMinutes });

    const rows = await this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql`UPDATE worker_configs c SET config = (c.config - 'cliUpdateCheckMinutes') || ${patch}::jsonb,
        version = c.version + 1, updated_by = ${userId}::uuid, updated_at = now() FROM workers w
        WHERE c.worker_id = w.id AND w.id = ${workerId}::uuid AND w.owner_user_id = ${userId}::uuid
          AND c.version = ${expectedConfigVersion} RETURNING c.worker_id`;
      }).pipe(queryFamily("workers.store"), queryRpc),
    );

    if (!rows.length) throw new ConnectError("worker configuration changed; reload and retry", Code.FailedPrecondition);
  }
}
