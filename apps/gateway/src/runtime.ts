import { PgClient } from "@effect/sql-pg";
import { migrate, migrateOnline } from "@canopy/db";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { DatabaseMonitor, bindDatabaseMonitor, observedSql } from "./diagnostics/database.ts";
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
export function gatewayRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: { databaseDiagnostics?: boolean } = {},
) {
  const url = env["CANOPY_DATABASE_URL"];

  if (!url) throw new Error("CANOPY_DATABASE_URL is not set, e.g. postgres://canopy:...@127.0.0.1:5432/canopy");
  const database = PgClient.layer({ url: Redacted.make(url), applicationName: "canopy-gateway" });
  const secretsKey = loadSecretsKey(env);
  const monitor = new DatabaseMonitor();

  const measured =
    options.databaseDiagnostics === false ? database : observedSql(monitor).pipe(Layer.provideMerge(database));

  const runtime = ManagedRuntime.make(gatewayServices(secretsKey).pipe(Layer.provideMerge(measured)));
  bindDatabaseMonitor(runtime, monitor);

  return runtime;
}

/** Shared service composition for the application and opt-in database benchmarks. */
export function gatewayServices(secretsKey: Buffer) {
  return Layer.mergeAll(
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
  );
}

export type GatewayRuntime = ReturnType<typeof gatewayRuntime>;

/** Applies pending migrations (development; production runs them as a separate deploy step). */
export async function migrateDatabase(
  runtime: GatewayRuntime,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<string[]> {
  const mode = env["CANOPY_DATABASE_INDEX_MODE"] ?? "blocking";

  if (mode !== "blocking" && mode !== "concurrent")
    throw new Error("CANOPY_DATABASE_INDEX_MODE must be blocking or concurrent");
  const applied = await runtime.runPromise(mode === "concurrent" ? migrateOnline : migrate);

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

/** The web BFF's origin (CANOPY_WEB_ORIGIN): what HTTPS over Tailscale forwards to. The desktop sets it. */
export function webOrigin(env: Readonly<Record<string, string | undefined>>) {
  const value = env["CANOPY_WEB_ORIGIN"];

  if (!value) return undefined;
  const url = URL.parse(value);

  if (!url || !/^https?:$/.test(url.protocol) || url.origin !== value.replace(/\/$/, ""))
    throw new Error("CANOPY_WEB_ORIGIN must be an origin like http://127.0.0.1:3000");

  return url.origin;
}

export { Effect };
