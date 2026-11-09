import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, type SqlConnection } from "effect/sql";

export interface QuerySample {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly rows: number;
  readonly bytes: number;
}

/** In-memory, opt-in diagnostics only. Parameters and rows never enter benchmark output. */
export class Recorder {
  samples: QuerySample[] | undefined;
}

function measure<A extends readonly unknown[]>(recorder: Recorder, text: string, params: readonly unknown[], rows: A) {
  return Effect.sync(() => {
    const samples = recorder.samples;

    if (!samples) return;
    // A decoded JSON representation, not PostgreSQL wire bytes or physical I/O.
    const encoded = JSON.stringify(rows, (_, value) => (isBigInt(value) ? value.toString() : value));
    samples.push({ text, params, rows: rows.length, bytes: Buffer.byteLength(encoded) });
  });
}

const isBigInt = (value: unknown): value is bigint => typeof value === "bigint";

function traced(connection: SqlConnection.Connection, recorder: Recorder): SqlConnection.Connection {
  return {
    ...connection,
    execute: (text, params, transform) =>
      connection.execute(text, params, transform).pipe(Effect.tap((rows) => measure(recorder, text, params, rows))),
    executeUnprepared: (text, params, transform) =>
      connection
        .executeUnprepared(text, params, transform)
        .pipe(Effect.tap((rows) => measure(recorder, text, params, rows))),
    executeValues: (text, params) =>
      connection.executeValues(text, params).pipe(Effect.tap((rows) => measure(recorder, text, params, rows))),
    executeValuesUnprepared: (text, params) =>
      connection
        .executeValuesUnprepared(text, params)
        .pipe(Effect.tap((rows) => measure(recorder, text, params, rows))),
    executeStream: (text, params, transform) =>
      connection
        .executeStream(text, params, transform)
        .pipe(Stream.tap((row) => measure(recorder, text, params, [row]))),
    // The harness uses row-returning statements; fail closed if a new operation uses opaque results.
    executeRaw: () => Effect.die(new Error("Benchmark tracer does not support raw driver results")),
  };
}

/** A separate diagnostic pass uses this layer; latency runs use the original driver's pool. */
export const tracedSql = (recorder: Recorder) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const pg = yield* PgClient.PgClient;

      return yield* SqlClient.make({
        acquirer: pg.reserve.pipe(Effect.map((connection) => traced(connection, recorder))),
        compiler: PgClient.makeCompiler(),
        spanAttributes: [],
        driver: "pg",
      });
    }),
  ).pipe(Layer.provide(Reactivity.layer));
