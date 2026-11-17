import { Provider, type CommandResult } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";
import { recordUsage } from "./accounting.ts";

/** Command IDs deduplicate known GenerateText results; a lost ephemeral result cannot be recovered. */
export function accountGeneration(
  runtime: CoreRuntime,
  owner: string,
  provider: Provider,
  model: string,
  result: CommandResult,
) {
  const usages = result.consumedUsages.length
    ? result.consumedUsages
    : result.consumedUsage
      ? [result.consumedUsage]
      : [];

  if (!usages.length) return Promise.resolve();

  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const usage of usages)
            yield* recordUsage(
              sql,
              {
                owner,
                subject: `generation:${result.commandId}`,
                counter: result.commandId,
                provider: provider === Provider.CLAUDE ? "claude" : provider === Provider.CODEX ? "codex" : "grok",
                model,
              },
              usage,
              new Date(),
            );
        }),
      );
    }),
  );
}
