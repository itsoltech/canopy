import { PgClient } from "@effect/sql-pg";
import { migrate } from "@canopy/db";
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from "@canopy/domain";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { BotStore } from "./bots/store.ts";
import { AgentBusStore, AttachmentStore, BackgroundTaskStore, GatewayStore, GoalStore, Ingest, loadSecretsKey, ModelStore, InstanceStore, QueueStore, SettingsStore, SteerStore } from "./store/index.ts";

/** Database-backed services of the gateway, shared by main.ts and cli.ts. */
export function gatewayRuntime(env: Readonly<Record<string, string | undefined>>) {
  const url = env["OA_DATABASE_URL"];
  if (!url) throw new Error("OA_DATABASE_URL is not set, e.g. postgres://open_agents:...@127.0.0.1:5432/open_agents");
  const database = PgClient.layer({ url: Redacted.make(url), applicationName: "open-agents-gateway" });
  const secretsKey = loadSecretsKey(env);
  return ManagedRuntime.make(
    Layer.mergeAll(
      GatewayStore.layer(secretsKey),
      Ingest.layer,
      AgentBusStore.layer,
      SettingsStore.layer,
      ModelStore.layer,
      SteerStore.layer,
      QueueStore.layer,
      GoalStore.layer,
      InstanceStore.layer(secretsKey),
      AttachmentStore.layer,
      BackgroundTaskStore.layer,
      BotStore.layer(secretsKey),
    ).pipe(Layer.provideMerge(database)),
  );
}

export type GatewayRuntime = ReturnType<typeof gatewayRuntime>;

/** Applies pending migrations (development; production runs them as a separate deploy step). */
export async function migrateDatabase(runtime: GatewayRuntime): Promise<string[]> {
  const applied = await runtime.runPromise(migrate);
  return applied.map(([id, name]) => `${id}_${name}`);
}

export const ensureDevUser = (runtime: GatewayRuntime, email: string) =>
  runtime.runPromise(GatewayStore.use((s) => s.ensureUser(email, email.split("@")[0] ?? "dev")));

/**
 * Attachment limits (docs/ui-api.md, "Załączniki"): OA_ATTACHMENT_MAX_FILE_MB, OA_ATTACHMENT_MAX_MESSAGE_MB,
 * OA_ATTACHMENT_MAX_FILES; unset or invalid = the default.
 */
export function attachmentLimits(env: Readonly<Record<string, string | undefined>>): AttachmentLimits {
  const number = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const d = DEFAULT_ATTACHMENT_LIMITS;
  return {
    maxFileBytes: Math.round(number("OA_ATTACHMENT_MAX_FILE_MB", d.maxFileBytes / 1024 ** 2) * 1024 ** 2),
    maxMessageBytes: Math.round(number("OA_ATTACHMENT_MAX_MESSAGE_MB", d.maxMessageBytes / 1024 ** 2) * 1024 ** 2),
    maxFiles: Math.round(number("OA_ATTACHMENT_MAX_FILES", d.maxFiles)),
  };
}

export { Effect };
