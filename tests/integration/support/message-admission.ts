import type { GatewayCore } from "@canopy/gateway/core";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { TestRuntime } from "./gateway.ts";

/** Holds a message's checks (attachments read their limits first) until released; the next send is not held. */
export function pauseChecks(core: GatewayCore) {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const limits = core.attachmentLimits;
  let waiting = 0;

  Object.defineProperty(core, "attachmentLimits", {
    configurable: true,
    get: () => {
      waiting++;
      reached.resolve();

      return release.promise.then(() => limits);
    },
  });

  return {
    reached: reached.promise,
    waiting: () => waiting,
    release: () => {
      Reflect.deleteProperty(core, "attachmentLimits");
      release.resolve();
    },
  };
}

/** Locks the thread row the way any other write does; fails fast when an admission still holds it. */
export function lockedWrite(runtime: TestRuntime, threadId: string) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL lock_timeout='500ms'`;
          yield* sql`UPDATE threads SET updated_at=updated_at WHERE id=${threadId}::uuid`;
        }),
      );
    }),
  );
}

/** Connections of this database parked inside a transaction (a held pool connection). */
export function idleTransactions(runtime: TestRuntime) {
  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND state LIKE 'idle in transaction%' AND pid<>pg_backend_pid()`;

      return rows[0]?.n ?? 0;
    }),
  );
}
