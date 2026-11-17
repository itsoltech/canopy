import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "../core/core.ts";
import { coreState } from "../core/core-context.ts";
import { getUsageStats, usageWindow } from "../usage/query.ts";
import type { UiHandlers } from "./ui-service.ts";

export function usageHandlers(core: GatewayCore): Pick<UiHandlers, "getUsageStats"> {
  return {
    getUsageStats: (request) => {
      usageWindow(request);
      const { runtime, userId } = core[coreState].options;

      return runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* getUsageStats(sql, userId, request);
        }),
      );
    },
  };
}
