import { Provider, type ProfileModels } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { coreState } from "../core/core-context.ts";
import type { GatewayCore } from "../core/core.ts";
import { accountGeneration } from "../usage/generation.ts";
import type { WorkerConnection } from "../worker-link/index.ts";
import { checkSources, type ReflectionSettings, type ReflectionSource } from "./reflection-source.ts";
import { lockReflectionWorker, reflectionProfiles } from "./reflection-profiles.ts";
import { lockedOwnerModule } from "../store/module-access.ts";
import { NATIVE_ID } from "../store/instance-config.ts";

function smallTier(provider: Provider, id: string) {
  if (provider === Provider.CLAUDE) return /\bhaiku\b/i.test(id) ? 0 : Infinity;

  if (provider === Provider.CODEX && /\bluna\b/i.test(id)) return 0;

  return /\bmini\b/i.test(id) ? 1 : Infinity;
}

type ModelSelection = Pick<ReflectionSettings, "model" | "effort">;

type GenerationProfile = ModelSelection & Pick<ReflectionSettings, "owner_user_id" | "provider" | "profile_id">;

function reflectionModel(catalog: ProfileModels, settings: ModelSelection) {
  const listed = catalog.models.filter(
    (model) => model.id && !model.hidden && (!settings.effort || model.efforts.includes(settings.effort)),
  );

  const model = settings.model
    ? (listed.find((m) => m.id === settings.model) ??
      listed.find((m) => m.resolvedModel === settings.model || m.aliases.includes(settings.model)))
    : listed
        .map((m) => ({ m, tier: smallTier(catalog.provider, m.resolvedModel || m.id) }))
        .filter(({ tier }) => Number.isFinite(tier))
        .sort((a, b) => a.tier - b.tier || b.m.id.localeCompare(a.m.id, "en", { numeric: true }))[0]?.m;

  if (!model) return undefined;

  const effort =
    settings.effort ||
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"].find((e) => model.efforts.includes(e)) ||
    model.efforts[0] ||
    "";

  return { model: model.id, effort };
}

interface GenerationTarget {
  worker: { id: string; name: string; version: bigint };
  connection: WorkerConnection;
  provider: Provider;
  profileId: string;
  model: string;
  effort: string;
}

export async function textGenerationTarget(
  core: GatewayCore,
  settings: GenerationProfile,
  preferred?: ModelSelection & { workerId?: string },
): Promise<GenerationTarget | undefined> {
  const connections = new Map(
    [...core.link.connections].filter(
      ([id, connection]) =>
        (!preferred?.workerId || id === preferred.workerId) &&
        connection.isOpen &&
        connection.hello.capabilities.includes("generate_text"),
    ),
  );

  if (!connections.size) return undefined;

  const profiles = await core[coreState].options.runtime.runPromise(
    SqlClient.SqlClient.use((sql) => reflectionProfiles(sql, settings.owner_user_id, [...connections.keys()])),
  );

  const provider = settings.provider;
  const profileId = settings.profile_id || NATIVE_ID;

  for (const { worker, profile } of profiles) {
    if (profile.provider !== provider || (profile.profileId || NATIVE_ID) !== profileId) continue;
    const connection = connections.get(worker.id);

    if (!connection?.isOpen) continue;
    const choice = reflectionModel(profile, settings) ?? (preferred && reflectionModel(profile, preferred));

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

          if (!(yield* lockReflectionWorker(sql, owner, worker))) return undefined;

          if (relocation?.draining || !connection.isOpen || core.link.connections.get(worker.id) !== connection)
            return undefined;
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
