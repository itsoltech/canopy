import { PgClient } from "@effect/sql-pg";
import { Effect, Exit, Layer, Scope, Stream, Schema } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, type SqlConnection, SqlError } from "effect/sql";
import { databaseMetric, type DatabaseFamily, type DatabasePhase } from "@canopy/domain/diagnostics";
import type { RpcCollector } from "./collector.ts";
import { QueryFamily, QueryRpc } from "./query-context.ts";
import type { CoreRuntime } from "../core/core-context.ts";

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
    const elapsed = performance.now() - start;
    this.collector?.measure(databaseMetric(family, phase), elapsed, error, rpc);

    if (phase === "execute") {
      this.collector?.measure(11, 1);

      if (family === "other") this.collector?.measure(10, 1);
    }

    if (phase === "reserve") this.collector?.measure(12, elapsed, error);
  }
}

function observed<A, E, R>(monitor: DatabaseMonitor, phase: DatabasePhase, work: Effect.Effect<A, E, R>) {
  return Effect.suspend(() => {
    if (!monitor.enabled) return work;

    return Effect.gen(function* () {
      const family = yield* QueryFamily;
      const rpc = yield* QueryRpc;
      const start = performance.now();

      return yield* work.pipe(
        Effect.onExit((exit) => Effect.sync(() => monitor.record(family, phase, start, Exit.isFailure(exit), rpc))),
      );
    });
  });
}

/** Wrap only execution effects. Text/parameters go straight to the driver, never the observer. */
export function observedConnection(
  connection: SqlConnection.Connection,
  monitor: DatabaseMonitor,
): SqlConnection.Connection {
  return {
    execute: (text, params, transform) => observed(monitor, "execute", connection.execute(text, params, transform)),
    executeUnprepared: (text, params, transform) =>
      observed(monitor, "execute", connection.executeUnprepared(text, params, transform)),
    executeValues: (text, params) => observed(monitor, "execute", connection.executeValues(text, params)),
    executeValuesUnprepared: (text, params) =>
      observed(monitor, "execute", connection.executeValuesUnprepared(text, params)),
    executeRaw: (text, params) => observed(monitor, "execute", connection.executeRaw(text, params)),
    executeStream: (text, params, transform) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const family = yield* QueryFamily;
          const rpc = yield* QueryRpc;
          const start = performance.now();

          return connection.executeStream(text, params, transform).pipe(
            Stream.onExit((exit) =>
              Effect.sync(() => {
                if (monitor.enabled) monitor.record(family, "execute", start, Exit.isFailure(exit), rpc);
              }),
            ),
          );
        }),
      ),
  };
}

/** A child scope isolates release time from lease lifetime, including failed finalizers. */
export function observedReserve(acquire: SqlConnection.Acquirer, monitor: DatabaseMonitor): SqlConnection.Acquirer {
  return Effect.suspend(() => {
    if (!monitor.enabled) return acquire;

    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const child = yield* Scope.make();
        const family = yield* QueryFamily;
        const rpc = yield* QueryRpc;
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
        yield* Effect.addFinalizer((exit) =>
          Effect.suspend(() => {
            const released = performance.now();

            return Scope.close(child, exit).pipe(
              Effect.onExit((release) =>
                Effect.sync(() => {
                  monitor.occupied--;
                  monitor.record(family, "release", released, Exit.isFailure(release), rpc);
                }),
              ),
            );
          }),
        );

        return observedConnection(result.value, monitor);
      }),
    );
  });
}

const CommitResult = Schema.Struct({ command: Schema.String });

/** Preserve PgClient's COMMIT/ROLLBACK and savepoint semantics, on its original pool. */
export const observedSql = (monitor: DatabaseMonitor) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const pg = yield* PgClient.PgClient;
      monitor.stats = pg.poolStats;

      const sql = yield* SqlClient.make({
        acquirer: observedReserve(pg.reserve, monitor),
        compiler: PgClient.makeCompiler(),
        driver: "pg",
        spanAttributes: [],
        transactionService: pg.transactionService,
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
