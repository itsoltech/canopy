import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Provider, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { UiHandlers } from "../api/ui-service.ts";
import { unwrap } from "../api/ui-errors.ts";
import { coreState } from "../core/core-context.ts";
import type { GatewayCore } from "../core/core.ts";
import { Invalid, NotFound } from "../store/errors.ts";
import { INSTANCE_ID, NATIVE_ID } from "../store/instance-config.ts";
import { applyInstanceModels, harnessOf, InstanceStore, ModelStore, SettingsConflict } from "../store/index.ts";
import { uuid } from "./model.ts";
import { cancelReflection } from "./reflection-generation.ts";
import { resolveHabit, suggestionsFor } from "./reflection-review.ts";

const DEFAULT_INTERVAL_MINUTES = 1_440;
const INTERVALS = new Set([360, 720, DEFAULT_INTERVAL_MINUTES, 4_320, 10_080]);

interface SettingsRow {
  enabled: boolean;
  interval_minutes: number;
  project_ids: string[];
  worker_id: string | null;
  provider: Provider;
  profile_id: string;
  model: string;
  effort: string;
  revision: number;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_run_state: string;
}

function settingsMessage(row: SettingsRow | undefined): ui.MemoryReflectionSettings {
  if (!row) return create(ui.MemoryReflectionSettingsSchema, { intervalMinutes: DEFAULT_INTERVAL_MINUTES });

  return create(ui.MemoryReflectionSettingsSchema, {
    enabled: row.enabled,
    intervalMinutes: row.interval_minutes,
    projectIds: row.project_ids,
    workerId: row.worker_id ?? "",
    provider: row.provider,
    profileId: row.profile_id,
    model: row.model,
    effort: row.effort,
    revision: row.revision,
    ...(row.next_run_at && { nextRunAt: timestampFromDate(new Date(row.next_run_at)) }),
    ...(row.last_run_at && { lastRunAt: timestampFromDate(new Date(row.last_run_at)) }),
    lastRunState: row.last_run_state,
  });
}

function settingsRows(sql: SqlClient.SqlClient, owner: string, lock = false) {
  return sql<SettingsRow>`SELECT * FROM memory_reflection_settings WHERE owner_user_id=${owner}::uuid
    ${lock ? sql`FOR UPDATE` : sql``}`;
}

function projectsFor(sql: SqlClient.SqlClient, owner: string) {
  return sql<{ id: string; name: string }>`SELECT id,name FROM projects
    WHERE owner_user_id=${owner}::uuid AND kind='project' AND archived_at IS NULL AND NOT config_deleted
    ORDER BY name,id`;
}

function reflectionModels(sql: SqlClient.SqlClient, owner: string, projectIds?: string[], workerId?: string) {
  return Effect.gen(function* () {
    const workers = yield* sql<{ id: string; name: string }>`
      SELECT w.id,w.name FROM workers w
      WHERE w.owner_user_id=${owner}::uuid
        AND w.archived_at IS NULL AND w.revoked_at IS NULL
        ${workerId ? sql`AND w.id=${workerId}::uuid` : sql``}
        AND EXISTS (
          SELECT 1 FROM project_workspaces pw JOIN projects p ON p.id=pw.project_id
          WHERE pw.worker_id=w.id AND pw.archived_at IS NULL
            AND p.owner_user_id=${owner}::uuid AND p.kind='project' AND p.archived_at IS NULL AND NOT p.config_deleted
        )
        ${
          projectIds?.length
            ? sql`AND NOT EXISTS (
          SELECT 1 FROM unnest(${projectIds}::uuid[]) AS selected(project_id)
          WHERE NOT EXISTS (
            SELECT 1 FROM project_workspaces pw WHERE pw.project_id=selected.project_id
              AND pw.worker_id=w.id AND pw.archived_at IS NULL
          )
        )`
            : sql``
        }
      ORDER BY w.name,w.id`;

    if (!workers.length) return [];

    const instances = yield* InstanceStore.use((store) => store.workerInstances());

    const catalogs = yield* ModelStore.use((store) =>
      store.catalogs(
        owner,
        workers.map(({ id }) => id),
      ),
    );

    const rules = yield* InstanceStore.use((store) => store.modelRules());
    const catalogByWorker = new Map(catalogs.map((catalog) => [catalog.workerId, applyInstanceModels(catalog, rules)]));

    // Both the catalog and the last applied profile report survive a worker disconnect.
    return workers.flatMap(({ id, name }) =>
      (catalogByWorker.get(id)?.profiles ?? []).flatMap((profile) => {
        const profileId = profile.profileId || NATIVE_ID;

        const eligible = instances
          .get(id)
          ?.some(
            (instance) =>
              instance.harness === profile.provider &&
              instance.id === profileId &&
              instance.enabled &&
              instance.available,
          );

        if (!eligible) return [];

        return profile.models.flatMap((model) =>
          model.id && !model.hidden
            ? [
                create(ui.MemoryReflectionModelSchema, {
                  workerId: id,
                  workerName: name,
                  provider: profile.provider,
                  profileId,
                  model: model.id,
                  label: model.displayName || model.id,
                  efforts: model.efforts,
                }),
              ]
            : [],
        );
      }),
    );
  });
}

type SettingsInput = Pick<
  ui.MemoryReflectionSettings,
  "enabled" | "intervalMinutes" | "projectIds" | "workerId" | "provider" | "profileId" | "model" | "effort" | "revision"
>;

function checkedSettings(input: ui.MemoryReflectionSettings | undefined): SettingsInput {
  if (!input || !INTERVALS.has(input.intervalMinutes)) throw new Invalid("Choose a valid reflection schedule.");
  const { enabled, intervalMinutes, provider, profileId, model, effort, revision } = input;
  const projectIds = [...new Set(input.projectIds.map(uuid))];
  const workerId = input.workerId ? uuid(input.workerId) : "";

  if (enabled && !projectIds.length) throw new Invalid("Select at least one project.");

  if (
    workerId
      ? !harnessOf(provider) || !profileId
      : enabled || provider !== Provider.UNSPECIFIED || profileId || model || effort
  )
    throw new Invalid("Choose a reflection provider profile.");

  if (
    (profileId && !INSTANCE_ID.test(profileId)) ||
    model.length > 200 ||
    model.includes("\0") ||
    (effort && (!model || !/^[a-z][a-z0-9_-]{0,39}$/.test(effort)))
  )
    throw new Invalid("Choose a valid reflection model and effort.");

  return { enabled, intervalMinutes, projectIds, workerId, provider, profileId, model, effort, revision };
}

function sameModel(input: SettingsInput, old: SettingsRow | undefined) {
  return (
    old?.worker_id === input.workerId &&
    old.provider === input.provider &&
    old.profile_id === input.profileId &&
    old.model === input.model &&
    old.effort === input.effort
  );
}

function validateSelection(
  sql: SqlClient.SqlClient,
  owner: string,
  input: SettingsInput,
  old: SettingsRow | undefined,
) {
  return Effect.gen(function* () {
    const projects = new Set((yield* projectsFor(sql, owner)).map((project) => project.id));
    const previous = new Set(input.enabled ? [] : old?.project_ids);

    if (input.projectIds.some((id) => !projects.has(id) && !previous.has(id)))
      return yield* Effect.fail(new Invalid("Choose projects available on this computer."));

    // Allow turning reflection off when a saved project or provider has become unavailable.
    if (!input.workerId || (!input.enabled && sameModel(input, old))) return;
    const models = yield* reflectionModels(sql, owner, input.projectIds, input.workerId);

    const eligible = models.some(
      (model) =>
        model.provider === input.provider &&
        model.profileId === input.profileId &&
        (!input.model || model.model === input.model) &&
        (!input.effort || model.efforts.includes(input.effort)),
    );

    if (!eligible)
      return yield* Effect.fail(
        new Invalid("Choose a model and provider profile available for the selected projects."),
      );
  });
}

function writeSettings(sql: SqlClient.SqlClient, owner: string, input: SettingsInput) {
  const conflict = new SettingsConflict("Reflection settings changed. Reload them and try again.");

  return sql.withTransaction(
    Effect.gen(function* () {
      const [old] = yield* settingsRows(sql, owner, true);

      if (input.revision !== (old?.revision ?? 0)) return yield* Effect.fail(conflict);
      yield* validateSelection(sql, owner, input, old);
      const { enabled, intervalMinutes, projectIds, workerId, provider, profileId, model, effort, revision } = input;

      const [row] = yield* sql<SettingsRow>`
        INSERT INTO memory_reflection_settings AS s
          (owner_user_id,enabled,interval_minutes,project_ids,worker_id,provider,profile_id,model,effort,revision,next_run_at)
        VALUES (${owner}::uuid,${enabled},${intervalMinutes},${projectIds}::uuid[],${workerId || null}::uuid,
          ${provider},${profileId},${model},${effort},1,CASE WHEN ${enabled} THEN clock_timestamp() END)
        ON CONFLICT (owner_user_id) DO UPDATE SET enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,
          project_ids=excluded.project_ids,worker_id=excluded.worker_id,provider=excluded.provider,
          profile_id=excluded.profile_id,model=excluded.model,effort=excluded.effort,revision=s.revision+1,
          next_run_at=CASE
            WHEN NOT excluded.enabled THEN NULL
            WHEN NOT s.enabled THEN clock_timestamp()
            WHEN excluded.interval_minutes<>s.interval_minutes THEN clock_timestamp()+make_interval(mins=>excluded.interval_minutes)
            ELSE s.next_run_at
          END
        WHERE s.revision=${revision}
        RETURNING s.*`;

      return row ? settingsMessage(row) : yield* Effect.fail(conflict);
    }),
  );
}

function reflectionUsage(sql: SqlClient.SqlClient, owner: string) {
  return sql<{
    attempts: number;
    input_tokens: bigint;
    output_tokens: bigint;
    reported_cost: number | null;
  }>`
    SELECT count(DISTINCT r.id)::int AS attempts,
      coalesce(sum((c.totals->>'inputTokens')::bigint),0)::bigint AS input_tokens,
      coalesce(sum((c.totals->>'outputTokens')::bigint),0)::bigint AS output_tokens,
      sum(coalesce((c.totals->>'reportedCostUsd')::double precision,0)) FILTER (
        WHERE (c.totals->>'reports')::bigint > coalesce((c.totals->>'unknownCostReports')::bigint,0)
      ) AS reported_cost
    FROM memory_reflection_runs r LEFT JOIN usage_counters c
      ON c.owner_user_id=r.owner_user_id AND c.subject_id='generation:' || r.id::text
    WHERE r.owner_user_id=${owner}::uuid AND r.created_at>=now()-interval '30 days'`.pipe(
    Effect.map(([row]) =>
      create(ui.MemoryReflectionUsageSchema, {
        attempts: row?.attempts ?? 0,
        inputTokens: BigInt(row?.input_tokens ?? 0),
        outputTokens: BigInt(row?.output_tokens ?? 0),
        reportedCostUsd: row?.reported_cost ?? undefined,
      }),
    ),
  );
}

async function reflectionGuard<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    const error = unwrap(cause);

    if (error instanceof Invalid) throw new ConnectError(error.message, Code.InvalidArgument);

    if (error instanceof NotFound) throw new ConnectError(error.message, Code.NotFound);

    if (error instanceof SettingsConflict) throw new ConnectError(error.message, Code.FailedPrecondition);

    // Keep private rules and bound SQL parameters out of RPC errors and logs.
    throw new ConnectError("Could not access Habits. Try again.", Code.Internal);
  }
}

export function reflectionHandlers(
  core: GatewayCore,
): Pick<UiHandlers, "getMemoryHabits" | "updateMemoryReflection" | "resolveMemoryHabit"> {
  const { userId } = core[coreState].options;
  const { actions } = core[coreState];

  return {
    getMemoryHabits: () =>
      reflectionGuard(() =>
        actions.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [settings] = yield* settingsRows(sql, userId);
            const projects = yield* projectsFor(sql, userId);
            const models = yield* reflectionModels(sql, userId);
            const suggestions = yield* suggestionsFor(sql, userId);
            const usage = yield* reflectionUsage(sql, userId);

            return create(ui.MemoryHabitsSnapshotSchema, {
              settings: settingsMessage(settings),
              projects: [...projects],
              models,
              suggestions: [...suggestions],
              usage,
            });
          }),
        ),
      ),
    updateMemoryReflection: (request) =>
      reflectionGuard(async () => {
        const input = checkedSettings(request.settings);
        const updated = await actions.run(SqlClient.SqlClient.use((sql) => writeSettings(sql, userId, input)));

        const cancel = () => {
          // The saved revision fences stale results even if the worker misses cancellation.
          void cancelReflection(core).catch(() => undefined);
        };

        if (!actions.defer(cancel)) cancel();

        return updated;
      }),
    resolveMemoryHabit: (request) =>
      reflectionGuard(() => actions.run(SqlClient.SqlClient.use((sql) => resolveHabit(sql, userId, request)))),
  };
}
