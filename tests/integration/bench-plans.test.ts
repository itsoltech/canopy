import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/sql";
import { PlanCapture } from "../../scripts/bench/plan-capture.ts";
import { Recorder, tracedSql } from "../../scripts/bench/trace.ts";

describe.skipIf(!dockerAvailable)("rolled-back benchmark plans", () => {
  let pg: TestPostgres;
  const recorder = new Recorder();
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;
  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(tracedSql(recorder).pipe(Layer.provide(pg.layer)));
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE bench_plan_rows(id int PRIMARY KEY,value int NOT NULL)`;
      }),
    );
  });
  afterAll(async () => {
    await runtime?.dispose();
    await pg?.stop();
  });

  test("plans preserve exactly-once writes, nested savepoints and rollback after a failed plan", async () => {
    const capture = new PlanCapture();
    recorder.planCapture = capture;
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO bench_plan_rows VALUES(1,0)`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE bench_plan_rows SET value=value+1 WHERE id=1`;
            yield* sql.withTransaction(sql`UPDATE bench_plan_rows SET value=value+2 WHERE id=1`);
            expect(
              (yield* sql<{ value: number }>`SELECT value FROM bench_plan_rows WHERE id=1 FOR UPDATE SKIP LOCKED`)[0]
                ?.value,
            ).toBe(3);
          }),
        );
        yield* sql
          .withTransaction(
            sql`INSERT INTO bench_plan_rows VALUES(2,0)`.pipe(
              Effect.andThen(Effect.fail(new Error("rollback original"))),
            ),
          )
          .pipe(Effect.catch(() => Effect.void));
        expect(yield* sql`SELECT id FROM bench_plan_rows WHERE id=2`).toEqual([]);
        // EXPLAIN failure must roll back its savepoint, leaving the original transaction usable.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const [connection] = Option.getOrThrow(yield* Effect.serviceOption(sql.transactionService));
            yield* capture.capture(connection, "UPDATE missing_bench_relation SET value=1", [], true);
            expect((yield* sql<{ value: number }>`SELECT value FROM bench_plan_rows WHERE id=1`)[0]?.value).toBe(3);
          }),
        );
      }),
    );
    expect(capture.plans.length).toBeGreaterThan(5);
    expect(capture.plans.filter((plan) => Object.hasOwn(plan, "error"))).toHaveLength(1);
  });
});
