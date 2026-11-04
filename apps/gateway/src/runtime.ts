import { PgClient } from "@effect/sql-pg";
import { migrate } from "@canopy/db";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { BotStore } from "./bots/store.ts";
import {
  AgentBusStore,
  AttachmentStore,
  BackgroundTaskStore,
  GatewayStore,
  GoalStore,
  Ingest,
  loadSecretsKey,
  ModelStore,
  InstanceStore,
  QueueStore,
  SettingsStore,
  SteerStore,
} from "./store/index.ts";

/** Database-backed services of the gateway, shared by main.ts and cli.ts. */
export function gatewayRuntime(env: Readonly<Record<string, string | undefined>>) {
  const url = env["CANOPY_DATABASE_URL"];

  if (!url) throw new Error("CANOPY_DATABASE_URL is not set, e.g. postgres://canopy:...@127.0.0.1:5432/canopy");
  const database = PgClient.layer({ url: Redacted.make(url), applicationName: "canopy-gateway" });
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

/** CANOPY_NETWORK_PORT: a server (container) fixes the network access port it publishes.
 * Unset = the port chosen in the app (docs/network-access.md). */
export function networkPort(env: Readonly<Record<string, string | undefined>>) {
  const value = env["CANOPY_NETWORK_PORT"];

  if (!value) return undefined;
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("CANOPY_NETWORK_PORT must be a port number from 1 to 65535");

  return port;
}

export { Effect };
