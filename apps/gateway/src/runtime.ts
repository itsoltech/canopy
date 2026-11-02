import { PgClient } from "@effect/sql-pg";
import { migrate } from "@open-agents/db";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { AgentBusStore, GatewayStore, GoalStore, Ingest, loadSecretsKey, ModelStore, ProfileStore, SettingsStore, SteerStore } from "./store/index.ts";

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
      GoalStore.layer,
      ProfileStore.layer(secretsKey),
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

export { Effect };
