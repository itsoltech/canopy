import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreState } from "../core/core-context.ts";
import type { GatewayCore } from "../core/core.ts";
import { ownerModule } from "../store/module-access.ts";
import { reflectionGenerate, reflectionTarget, reflectionWorkspaces } from "./reflection-generation.ts";
import { saveReflectionProposal } from "./reflection-job-evidence.ts";
import { reflectionBatch, reflectionProposals } from "./reflection-prompt.ts";
import { checkSources, recordSources, reflectionSources, type ReflectionSettings } from "./reflection-source.ts";

function due(sql: SqlClient.SqlClient, owner: string, now: Date) {
  return sql<ReflectionSettings>`SELECT * FROM memory_reflection_settings WHERE owner_user_id=${owner}::uuid AND enabled
    AND next_run_at<=${now}
    AND NOT EXISTS(SELECT FROM memory_reflection_runs r WHERE r.owner_user_id=${owner}::uuid AND r.state='running')
    AND ${ownerModule(sql, owner, "threads")} FOR UPDATE SKIP LOCKED`;
}

function prepare(sql: SqlClient.SqlClient, owner: string, now: Date) {
  return sql.withTransaction(
    Effect.gen(function* () {
      // Always lock settings before a run, including recovery after restart.
      const [active] = yield* sql<{
        id: string;
      }>`SELECT id FROM memory_reflection_runs WHERE owner_user_id=${owner}::uuid
      AND state='running' AND lease_until<=${now}`;

      if (active) {
        yield* sql`SELECT FROM memory_reflection_settings WHERE owner_user_id=${owner}::uuid FOR UPDATE`;

        const [expired] = yield* sql<{ created_at: Date }>`UPDATE memory_reflection_runs SET state='unknown'
        WHERE id=${active.id}::uuid AND state='running' RETURNING created_at`;

        if (expired)
          yield* sql`UPDATE memory_reflection_settings SET last_run_state='unknown'
        WHERE owner_user_id=${owner}::uuid AND last_run_at=${expired.created_at}`;
      }

      const [settings] = yield* due(sql, owner, now);

      if (!settings) return undefined;
      const rows = yield* reflectionSources(sql, settings, now);
      const batch = reflectionBatch(rows);
      const project = rows[0]?.project_id;
      yield* recordSources(sql, owner, batch.skipped, null);

      if (!project || !batch.sources.size) {
        yield* scheduleNext(sql, settings, now, project ?? null, "empty");

        return undefined;
      }

      return { settings, project, batch };
    }),
  );
}

function scheduleNext(
  sql: SqlClient.SqlClient,
  settings: ReflectionSettings,
  now: Date,
  project: string | null,
  state: string,
) {
  const next = new Date(+now + (state === "unavailable" ? 15 : settings.interval_minutes) * 60000);

  return sql`UPDATE memory_reflection_settings SET last_run_at=${now},last_run_state=${state},next_run_at=${next},
    history_start=coalesce(history_start,${now}::timestamptz-interval '30 days'),last_project_id=${project}::uuid,
    last_attempt_at=CASE WHEN ${state}='running' THEN ${now}::timestamptz ELSE last_attempt_at END
    WHERE owner_user_id=${settings.owner_user_id}::uuid AND revision=${settings.revision} AND enabled`;
}

type Batch = ReturnType<typeof reflectionBatch>;

type Attempt = { settings: ReflectionSettings; project: string; batch: Batch };

function reserve(sql: SqlClient.SqlClient, run: Attempt, worker: string | undefined, now: Date) {
  const { settings, project, batch } = run;
  const owner = settings.owner_user_id;

  return sql.withTransaction(
    Effect.gen(function* () {
      const [current] = yield* due(sql, owner, now);

      if (current?.revision !== settings.revision) return undefined;

      if (!worker || !(yield* reflectionWorkspaces(sql, owner, project, worker)).length) {
        yield* scheduleNext(sql, settings, now, project, "unavailable");

        return undefined;
      }

      const sources = [...batch.sources.values()];

      if (!(yield* checkSources(sql, settings, now, sources))) return undefined;

      const [receipt] =
        yield* sql`SELECT FROM memory_reflection_checked WHERE message_id=ANY(${sources.map((s) => s.message_id)}::uuid[]) LIMIT 1`;

      if (receipt) return undefined;
      const id = Bun.randomUUIDv7();
      yield* sql`INSERT INTO memory_reflection_runs(id,owner_user_id,project_id,settings_revision,created_at,lease_until,state)
      VALUES(${id}::uuid,${owner}::uuid,${project}::uuid,${settings.revision},${now},${now}::timestamptz+interval '2 minutes','running')`;
      yield* recordSources(sql, owner, sources, id);
      yield* scheduleNext(sql, settings, now, project, "running");

      return id;
    }),
  );
}

type Generated = Awaited<ReturnType<typeof reflectionGenerate>>;

function finish(sql: SqlClient.SqlClient, run: Attempt, id: string, result: Generated, now: Date) {
  const { settings, project, batch } = run;
  const owner = settings.owner_user_id;
  const proposals = result.state === "completed" ? reflectionProposals(result.text, batch.sources) : undefined;

  return sql.withTransaction(
    Effect.gen(function* () {
      const [current] = yield* sql<{
        revision: number;
        enabled: boolean;
      }>`SELECT revision, enabled AND ${ownerModule(sql, owner, "threads")} AS enabled
      FROM memory_reflection_settings WHERE owner_user_id=${owner}::uuid FOR UPDATE`;

      const [lease] = yield* sql<{
        lease_until: Date;
        created_at: Date;
      }>`SELECT lease_until,created_at FROM memory_reflection_runs
      WHERE owner_user_id=${owner}::uuid AND id=${id}::uuid AND state='running' FOR UPDATE`;

      if (!lease) return;
      const valid = current?.enabled && current.revision === settings.revision;

      if (result.state === "unsent") {
        yield* sql`DELETE FROM memory_reflection_runs WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid`;
        yield* sql`UPDATE memory_reflection_settings SET last_attempt_at=NULL,last_run_state='unavailable',
          next_run_at=CASE WHEN enabled THEN least(next_run_at,${now}::timestamptz+interval '15 minutes') END
          WHERE owner_user_id=${owner}::uuid AND last_run_at=${lease.created_at}`;

        return;
      }

      let state: string = result.state;

      if (lease.lease_until <= now || result.state === "unknown") state = "unknown";
      else if (!valid || !(yield* checkSources(sql, settings, now, [...batch.sources.values()]))) state = "superseded";
      else if (result.state === "completed") {
        if (proposals) {
          for (const proposal of proposals) yield* saveReflectionProposal(sql, owner, project, now, proposal);
        } else state = "invalid";
      }

      yield* sql`UPDATE memory_reflection_runs SET state=${state} WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid`;

      yield* sql`UPDATE memory_reflection_settings SET last_run_state=${state}
        WHERE owner_user_id=${owner}::uuid AND last_run_at=${lease.created_at}`;

      // Known failures leave these messages eligible in the next budget period. Unknown sends keep their receipts.
      if (result.state !== "unknown" && ["failed", "invalid", "superseded"].includes(state))
        yield* sql`DELETE FROM memory_reflection_checked WHERE owner_user_id=${owner}::uuid AND run_id=${id}::uuid`;
    }),
  );
}

/** Resolves after the owner's attempt, accounting and evidence commit. The injected clock also drives lease recovery. */
export async function tickReflection(core: GatewayCore, now = new Date()) {
  const { runtime, userId, relocation } = core[coreState].options;

  if (relocation?.draining) return;
  const started = performance.now();
  const run = await runtime.runPromise(SqlClient.SqlClient.use((sql) => prepare(sql, userId, now)));

  if (!run) return;

  const target = await reflectionTarget(core, run.settings, run.project);

  if (relocation?.draining) return;

  const id = await runtime.runPromise(
    SqlClient.SqlClient.use((sql) => reserve(sql, run, target?.connection.isOpen ? target.worker.id : undefined, now)),
  );

  if (!id || !target) return;
  const currentTime = () => new Date(+now + performance.now() - started);

  const result = await reflectionGenerate(
    core,
    target,
    run.settings,
    id,
    run.batch.prompt,
    [...run.batch.sources.values()],
    currentTime(),
  );

  const finished = currentTime();
  await runtime.runPromise(SqlClient.SqlClient.use((sql) => finish(sql, run, id, result, finished)));
}

export class ReflectionJob {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  constructor(readonly core: GatewayCore) {}
  start() {
    this.#timer ??= setInterval(() => {
      this.#running ??= tickReflection(this.core)
        .catch(() => {
          this.core[coreState].options.log?.("Memory reflection could not finish its scheduled check");
        })
        .finally(() => {
          this.#running = undefined;
        });
    }, 30_000);
  }
  async stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
