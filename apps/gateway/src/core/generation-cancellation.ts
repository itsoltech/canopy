import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { lockModuleAdmission, moduleDisabledMessage, ownerModule } from "../store/module-access.ts";
import type { WorkerConnection, CommandInit } from "../worker-link/index.ts";
import { coreState, InvalidError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";

const pending = new WeakMap<WorkerConnection, Map<string, bigint>>();

function generationState(core: GatewayCore, lock: boolean) {
  const { actions, options } = core[coreState];
  const owner = options.userId;

  return actions.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      if (lock) yield* lockModuleAdmission(sql, owner);

      const [row] = yield* sql<{ enabled: boolean; version: string }>`
      SELECT ${ownerModule(sql, owner, "threads")} AS enabled, coalesce((SELECT settings->>'threadsDisabledVersion'
        FROM user_settings WHERE user_id = ${owner}::uuid), '0') AS version`;

      return { enabled: row!.enabled, version: BigInt(row!.version) };
    }),
  );
}

/** Serialize admission or application of a generated name with a module change, including a rapid off/on. */
export function withGenerationVersion<T>(core: GatewayCore, expected: bigint | undefined, use: (version: bigint) => T) {
  return core[coreState].actions.transaction(async () => {
    const { enabled, version } = await generationState(core, true);

    if (!enabled || (expected !== undefined && version !== expected))
      throw new InvalidError(moduleDisabledMessage("threads"));

    return use(version);
  });
}

export function sendGeneration(
  connection: WorkerConnection,
  command: Extract<CommandInit, { case: "generateText" }>,
  version: bigint,
) {
  const commandId = Bun.randomUUIDv7();
  const jobs = pending.get(connection) ?? new Map<string, bigint>();

  if (connection.hello.capabilities.includes("cancel_text_generation_v1")) {
    pending.set(connection, jobs);
    jobs.set(commandId, version);
  }

  const ack = connection
    .sendCommand(command, 32_000, commandId)
    .catch(() => undefined)
    .finally(() => jobs.delete(commandId));

  return { ack, version };
}

/** A local setting change notifies immediately. Heartbeats also observe changes committed by another gateway. */
export async function cancelStaleGenerations(core: GatewayCore, connections: Iterable<WorkerConnection>) {
  const active = Array.from(connections).filter((connection) => pending.get(connection)?.size);

  if (!active.length) return;
  const { version } = await generationState(core, false);

  for (const connection of active) {
    const jobs = pending.get(connection)!;

    for (const [commandId, started] of jobs) {
      if (started >= version) continue;
      jobs.delete(commandId);
      void connection.sendCommand({ case: "cancelTextGeneration", value: { commandId } }).catch(() => {});
    }
  }
}
