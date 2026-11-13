import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, type SqlConnection } from "effect/sql";
import type { PlanCapture } from "./plan-capture.ts";

export interface QuerySample {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly rows: number;
  readonly bytes: number;
  readonly elapsedMs: number;
}

/** In-memory, opt-in diagnostics only. Parameters and rows never enter benchmark output. */
export class Recorder {
  samples: QuerySample[] | undefined;
  planCapture: PlanCapture | undefined;
}

function measure<A extends readonly unknown[]>(
  recorder: Recorder,
  text: string,
  params: readonly unknown[],
  rows: A,
  elapsedMs = 0,
) {
  return Effect.sync(() => {
    const samples = recorder.samples;

    if (!samples) return;
    // A decoded JSON representation, not PostgreSQL wire bytes or physical I/O.
    const encoded = JSON.stringify(rows, (_, value) => (isBigInt(value) ? value.toString() : value));
    samples.push({ text, params, rows: rows.length, bytes: Buffer.byteLength(encoded), elapsedMs });
  });
}

const isBigInt = (value: unknown): value is bigint => typeof value === "bigint";

function traced(connection: SqlConnection.Connection, recorder: Recorder): SqlConnection.Connection {
  let inTransaction = false;

  const before = (text: string, params: readonly unknown[]) =>
    recorder.planCapture?.capture(connection, text, params, inTransaction) ?? Effect.void;

  const observed = <A extends readonly unknown[]>(
    text: string,
    params: readonly unknown[],
    work: Effect.Effect<A, import("effect/sql").SqlError.SqlError>,
  ) =>
    Effect.andThen(
      before(text, params),
      Effect.suspend(() => {
        const start = performance.now();

        return work.pipe(
          Effect.tap((rows) => {
            if (/^BEGIN\b/i.test(text)) inTransaction = true;

            if (/^(?:COMMIT|ROLLBACK)\s*$/i.test(text)) inTransaction = false;

            return measure(recorder, text, params, rows, performance.now() - start);
          }),
        );
      }),
    );

  return {
    ...connection,
    execute: (text, params, transform) => observed(text, params, connection.execute(text, params, transform)),
    executeUnprepared: (text, params, transform) =>
      observed(text, params, connection.executeUnprepared(text, params, transform)),
    executeValues: (text, params) => observed(text, params, connection.executeValues(text, params)),
    executeValuesUnprepared: (text, params) => observed(text, params, connection.executeValuesUnprepared(text, params)),
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
      const pg = yield* SqlClient.SqlClient;

      return yield* SqlClient.make({
        acquirer: pg.reserve.pipe(Effect.map((connection) => traced(connection, recorder))),
        compiler: PgClient.makeCompiler(),
        spanAttributes: [],
        driver: "pg",
      });
    }),
  ).pipe(Layer.provide(Reactivity.layer));
