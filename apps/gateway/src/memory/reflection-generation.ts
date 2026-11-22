import { Provider, type ProfileModels, type ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreState } from "../core/core-context.ts";
import { coreForPickers, coreModelCatalogs } from "../core/core-models.ts";
import { coreWorkers } from "../core/core-providers.ts";
import type { GatewayCore } from "../core/core.ts";
import { accountGeneration } from "../usage/generation.ts";
import type { WorkerConnection } from "../worker-link/index.ts";
import { checkSources, type ReflectionSettings, type ReflectionSource } from "./reflection-source.ts";
import { lockedOwnerModule } from "../store/module-access.ts";

export function reflectionWorkspaces(
  sql: SqlClient.SqlClient,
  owner: string,
  project: string,
  worker: string | null,
  lock = false,
) {
  return sql<{ id: string }>`SELECT w.id FROM workers w JOIN project_workspaces pw ON pw.worker_id=w.id
    JOIN projects p ON p.id=pw.project_id AND p.owner_user_id=w.owner_user_id
    WHERE w.owner_user_id=${owner}::uuid AND w.revoked_at IS NULL AND w.archived_at IS NULL
      AND p.id=${project}::uuid AND p.kind='project' AND p.archived_at IS NULL AND NOT p.config_deleted
      AND pw.archived_at IS NULL AND (${worker}::uuid IS NULL OR w.id=${worker}::uuid)
      ORDER BY w.id,pw.id ${lock ? sql`FOR SHARE OF w,p,pw` : sql``}`;
}

function smallTier(provider: Provider, id: string) {
  if (provider === Provider.CLAUDE) return /\bhaiku\b/i.test(id) ? 0 : Infinity;

  if (provider === Provider.CODEX && /\bluna\b/i.test(id)) return 0;

  return /\bmini\b/i.test(id) ? 1 : Infinity;
}

function reflectionModel(catalog: ProfileModels, settings: ReflectionSettings) {
  const listed = catalog.models.filter((model) => model.id && !model.hidden);

  const model = settings.model
    ? listed.find((m) => [m.id, m.resolvedModel, ...m.aliases].includes(settings.model))
    : listed
        .map((m) => ({ m, tier: smallTier(catalog.provider, m.resolvedModel || m.id) }))
        .filter(({ tier }) => Number.isFinite(tier))
        .sort((a, b) => a.tier - b.tier || b.m.id.localeCompare(a.m.id, "en", { numeric: true }))[0]?.m;

  if (!model) return undefined;

  if (settings.effort && !model.efforts.includes(settings.effort)) return undefined;

  const effort =
    settings.effort ||
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"].find((e) => model.efforts.includes(e)) ||
    model.efforts[0] ||
    "";

  return { model: model.id, effort };
}

interface GenerationTarget {
  worker: ui.Worker;
  connection: WorkerConnection;
  provider: Provider;
  profileId: string;
  model: string;
  effort: string;
}

export async function reflectionTarget(
  core: GatewayCore,
  settings: ReflectionSettings,
  project: string,
): Promise<GenerationTarget | undefined> {
  const allowed = await core[coreState].options.runtime.runPromise(
    SqlClient.SqlClient.use((sql) => reflectionWorkspaces(sql, settings.owner_user_id, project, settings.worker_id)),
  );

  const ids = [...new Set(allowed.map((w) => w.id))].filter((id) =>
    core.link.connections.get(id)?.hello.capabilities.includes("generate_text"),
  );

  if (!ids.length) return undefined;

  const [workers, catalogs] = await Promise.all([
    coreWorkers(core),
    coreModelCatalogs(core, ids).then((models) => coreForPickers(core, models)),
  ]);

  const provider = settings.provider;
  const profileId = settings.profile_id || "native";

  for (const id of ids) {
    const worker = workers.find((w) => w.id === id);

    if (
      !worker?.providerInstances.some((i) => i.harness === provider && i.id === profileId && i.enabled && i.available)
    )
      continue;
    const connection = core.link.connections.get(id);

    if (!connection?.isOpen || !connection.hello.capabilities.includes("generate_text")) continue;

    const catalog = catalogs
      .find(
        (c) =>
          c.workerId === id && c.configVersion === worker.appliedVersion && c.configVersion === worker.configVersion,
      )
      ?.profiles.find((p) => p.provider === provider && (p.profileId || "native") === profileId);

    const choice = catalog && reflectionModel(catalog, settings);

    if (choice) return { worker, connection, provider, profileId, ...choice };
  }

  return undefined;
}

interface PendingGeneration {
  id: string;
  revision: number;
  connection: WorkerConnection;
}

const pending = new WeakMap<GatewayCore, PendingGeneration>();

export async function cancelReflection(core: GatewayCore) {
  const job = pending.get(core);

  if (!job || !job.connection.hello.capabilities.includes("cancel_text_generation_v1")) return;
  const { runtime, userId } = core[coreState].options;

  const valid = await runtime.runPromise(
    SqlClient.SqlClient.use(
      (sql) => sql`SELECT 1 FROM memory_reflection_settings
    WHERE owner_user_id=${userId}::uuid AND enabled AND revision=${job.revision}`,
    ),
  );

  if (valid.length || job !== pending.get(core)) return;
  pending.delete(core);
  await job.connection
    .sendCommand({ case: "cancelTextGeneration", value: { commandId: job.id } }, 5000)
    .catch(() => {});
}

/** Ephemeral command: no outbox redelivery. Accounting survives invalid JSON, disable and late results. */
export async function reflectionGenerate(
  core: GatewayCore,
  target: GenerationTarget,
  settings: ReflectionSettings,
  id: string,
  prompt: string,
  sources: ReflectionSource[],
  now: Date,
) {
  const { connection, provider, profileId, model, effort, worker } = target;
  const { runtime, relocation } = core[coreState].options;
  const job = { id, revision: settings.revision, connection };

  // The budget reservation committed separately. Hold admission locks only through queuing the command on the link.
  const sent = await runtime.runPromise(
    SqlClient.SqlClient.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const owner = settings.owner_user_id;

          if (!(yield* lockedOwnerModule(sql, owner, "threads"))) return undefined;

          const [live] =
            yield* sql`SELECT FROM memory_reflection_settings s JOIN memory_reflection_runs r USING(owner_user_id)
      WHERE s.owner_user_id=${owner}::uuid AND s.enabled AND s.revision=${settings.revision}
        AND r.id=${id}::uuid AND r.state='running' AND r.lease_until>${now} FOR SHARE OF s,r`;

          if (!live || !(yield* checkSources(sql, settings, now, sources))) return undefined;
          const projectId = sources[0]?.project_id;

          if (!projectId) return undefined;
          const allowed = yield* reflectionWorkspaces(sql, owner, projectId, worker.id, true);

          if (relocation?.draining || !connection.isOpen || !allowed.length) return undefined;
          pending.set(core, job);

          return {
            ack: connection
              .sendCommand(
                {
                  case: "generateText",
                  value: { provider, profileId, model, effort, prompt },
                },
                32_000,
                id,
              )
              .catch(() => undefined),
          };
        }),
      ),
    ),
  );

  if (!sent) return { state: "unsent" as const };
  const cancellation = setInterval(() => void cancelReflection(core).catch(() => {}), 3000);

  try {
    const result = await sent.ack;

    if (!result) return { state: "unknown" as const };
    await accountGeneration(core[coreState].options.runtime, settings.owner_user_id, provider, model, result, worker);

    return result.ok ? { state: "completed" as const, text: result.generatedText } : { state: "failed" as const };
  } finally {
    clearInterval(cancellation);

    if (pending.get(core) === job) pending.delete(core);
  }
}
