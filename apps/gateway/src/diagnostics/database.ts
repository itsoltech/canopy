import { PgClient, PgPool } from "@effect/sql-pg";
import { Effect, Exit, Layer, Scope, Schema } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, type SqlConnection, SqlError } from "effect/sql";
import { databaseMetric, type DatabaseFamily, type DatabasePhase } from "@canopy/domain/diagnostics";
import type { RpcCollector } from "./collector.ts";
import { QueryFamily, QueryRpc } from "./query-context.ts";
import type { CoreRuntime } from "../core/core-context.ts";
import { observed, ObservedConnection } from "./database-connection.ts";
import { observedBorrow } from "./database-borrow.ts";
import { DatabaseConnection, databaseBorrower } from "./database-driver.ts";

const monitors = new WeakMap<object, DatabaseMonitor>();
export const bindDatabaseMonitor = (runtime: CoreRuntime, monitor: DatabaseMonitor) => monitors.set(runtime, monitor);
export const databaseMonitor = (runtime: CoreRuntime) => monitors.get(runtime);

export class DatabaseMonitor {
  collector: RpcCollector | undefined;
  waiting = 0;
  occupied = 0;
  peakWaiting = 0;
  peakOccupied = 0;
  stats: Effect.Effect<{ max: number; used: number; pending: number }> | undefined;
  capacity = 10;

  get enabled() {
    return Boolean(this.collector?.enabled && this.collector.gatewayEnabled);
  }

  record(family: DatabaseFamily, phase: DatabasePhase, start: number, error: boolean, rpc: number) {
    const now = performance.now();
    this.collector?.recordDatabase(databaseMetric(family, phase), now - start, error, rpc, now);
  }
}

/** A lease finalizer owns its scope, never the acquisition result or statement callback. */
function releaseLease(child: Scope.Scope, monitor: DatabaseMonitor, family: DatabaseFamily, rpc: number) {
  return <A, E>(exit: Exit.Exit<A, E>) =>
    Effect.suspend(() => {
      const start = performance.now();

      return Scope.close(child, exit).pipe(
        Effect.onExit((release) =>
          Effect.sync(() => {
            monitor.occupied--;
            monitor.record(family, "release", start, Exit.isFailure(release), rpc);
          }),
        ),
      );
    });
}

/** A child scope isolates release time from lease lifetime, including failed finalizers. */
export function observedReserve(acquire: SqlConnection.Acquirer, monitor: DatabaseMonitor): SqlConnection.Acquirer {
  return Effect.withFiber((fiber) => {
    if (!monitor.enabled) return acquire;
    const family = fiber.getRef(QueryFamily);
    const rpc = fiber.getRef(QueryRpc);

    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const child = yield* Scope.make();
        const start = performance.now();
        monitor.waiting++;
        monitor.peakWaiting = Math.max(monitor.peakWaiting, monitor.waiting);
        const result = yield* Effect.exit(restore(acquire.pipe(Effect.provideService(Scope.Scope, child))));
        monitor.waiting--;
        monitor.record(family, "reserve", start, Exit.isFailure(result), rpc);

        if (Exit.isFailure(result)) {
          yield* Scope.close(child, result);

          return yield* Effect.failCause(result.cause);
        }

        monitor.occupied++;
        monitor.peakOccupied = Math.max(monitor.peakOccupied, monitor.occupied);
        yield* Effect.addFinalizer(releaseLease(child, monitor, family, rpc));

        return new ObservedConnection(result.value, monitor);
      }),
    );
  });
}

const CommitResult = Schema.Struct({ command: Schema.String });

/** Preserve PgClient's transaction controls on one native pool, including its scope-free borrow. */
export const observedSql = (monitor: DatabaseMonitor) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const pool = yield* PgPool.PgPool;
      monitor.stats = pool.stats;

      const sql = yield* SqlClient.make({
        acquirer: observedReserve(
          Effect.map(pool.reserve, (connection) => new DatabaseConnection(connection)),
          monitor,
        ),
        borrower: observedBorrow(databaseBorrower(pool, monitor), monitor),
        compiler: PgClient.makeCompiler(),
        driver: "pg",
        spanAttributes: [],
        prepareTransactionControls: true,
        releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
        commit: (connection) =>
          Effect.flatMap(connection.executeRaw("COMMIT", []), (result) =>
            Schema.decodeUnknownSync(CommitResult)(result).command === "ROLLBACK"
              ? Effect.fail(
                  new SqlError.SqlError({
                    reason: new SqlError.UnknownError({
                      operation: "commit",
                      cause: new Error("COMMIT rolled back an aborted transaction"),
                    }),
                  }),
                )
              : Effect.void,
          ),
        onCommitFailure: (connection) => Effect.ignore(connection.executeUnprepared("ROLLBACK", [], undefined)),
      });

      const transaction = sql.withTransaction;

      return Object.assign(sql, {
        withTransaction: <A, E, R>(work: Effect.Effect<A, E, R>) => observed(monitor, "transaction", transaction(work)),
      });
    }),
  ).pipe(Layer.provide(Reactivity.layer));
