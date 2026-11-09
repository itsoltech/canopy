import { Layer } from "effect";
import type { TestPostgres } from "@canopy/db/testing";
import { join } from "node:path";
import { PlanCapture } from "./plan-capture.ts";
import { normalizedSql, sqlSourceIndex } from "./sql-inventory.ts";
import { Recorder, tracedSql } from "./trace.ts";

/** Opt-in diagnostic tests only: no parameters, rows, SQL text or identifiers enter the saved plans. */
export async function testAudit(database: TestPostgres["layer"], directory: string) {
  const sources = await sqlSourceIndex();
  const recorder = new Recorder();
  const plans = new PlanCapture((text) => sources.get(normalizedSql(text)) ?? []);

  return {
    layer: tracedSql(recorder).pipe(Layer.provideMerge(database)),
    start: () => {
      recorder.planCapture = plans;
    },
    flush: () =>
      Bun.write(
        join(directory, `${Bun.randomUUIDv7()}.json`),
        JSON.stringify({
          method:
            "Diagnostic integration fixtures, not latency samples or large benchmark datasets. Exact SQL-template matches do not prove a particular call site ran; dynamic fragments can remain unmatched. DML/locks rolled back before original execution; irreversible/session calls skipped.",
          plans: plans.plans,
        }),
      ),
  };
}
