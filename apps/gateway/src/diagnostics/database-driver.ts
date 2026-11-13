import { PgConnection, PgPool } from "@effect/sql-pg";
import { Effect, Stream } from "effect";
import type * as Arr from "effect/Array";
import type { SqlConnection } from "effect/sql";
import type { DatabaseMonitor } from "./database.ts";
import { ObservedConnection } from "./database-connection.ts";

type SqlParameters = Parameters<SqlConnection.Connection["execute"]>[1];

type Transform = Parameters<SqlConnection.Connection["execute"]>[2];

const rowsOf = (result: PgConnection.Result) => result.rows;

/** The public native protocol/pool APIs keep preparation, cancellation and stream pins. */
export class DatabaseConnection implements SqlConnection.Connection {
  constructor(readonly connection: PgConnection.PgConnection) {}

  execute(text: string, params: SqlParameters, transform: Transform) {
    const rows = Effect.map(this.connection.query(text, params), rowsOf);

    return transform ? Effect.map(rows, transform) : rows;
  }

  executeUnprepared(text: string, params: SqlParameters, transform: Transform) {
    const rows = Effect.map(this.connection.query(text, params, false), rowsOf);

    return transform ? Effect.map(rows, transform) : rows;
  }

  executeRaw(text: string, params: SqlParameters) {
    return this.connection.query(text, params);
  }

  executeValues(text: string, params: SqlParameters) {
    return this.connection.queryValues(text, params);
  }

  executeValuesUnprepared(text: string, params: SqlParameters) {
    return this.connection.queryValues(text, params, false);
  }

  executeStream(text: string, params: SqlParameters, transform: Transform) {
    const stream = this.connection.stream(text, params);

    return transform
      ? Stream.mapArray(stream, (rows) => {
          // SAFETY: SQL row-name transforms preserve the native nonempty chunk's row count.
          return transform(rows) as Arr.NonEmptyReadonlyArray<PgConnection.Row>;
        })
      : stream;
  }
}

/** Weak keys are physical sessions, never statements, watches, threads or admission identities. */
export function databaseBorrower(pool: PgPool.PgPool, monitor: DatabaseMonitor): SqlConnection.Borrower {
  const connections = new WeakMap<PgConnection.PgConnection, ObservedConnection>();
  let reserved = false;

  return (work) =>
    pool.use((connection) => {
      let observed = connections.get(connection);

      if (!observed) {
        observed = new ObservedConnection(new DatabaseConnection(connection), monitor);

        // At most ten live sessions. Reserve their wrappers/WeakMap within the collector budget.
        if (!reserved && monitor.enabled) reserved = monitor.collector?.budget.reserve(4096) ?? false;

        if (reserved) connections.set(connection, observed);
      }

      return work(observed);
    });
}
