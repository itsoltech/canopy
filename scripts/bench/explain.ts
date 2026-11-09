import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { BenchRuntime } from "./runtime.ts";
import type { QuerySample } from "./trace.ts";

interface Plan {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Index Name"?: string;
  readonly "Actual Rows": number;
  readonly "Actual Loops": number;
  readonly "Shared Hit Blocks": number;
  readonly "Shared Read Blocks": number;
  readonly "Temp Read Blocks": number;
  readonly "Temp Written Blocks": number;
  readonly Plans?: readonly Plan[];
}

function nodes(plan: Plan): object[] {
  return [
    {
      node: plan["Node Type"],
      relation: plan["Relation Name"],
      index: plan["Index Name"],
      rows: plan["Actual Rows"],
      loops: plan["Actual Loops"],
      hits: plan["Shared Hit Blocks"],
      reads: plan["Shared Read Blocks"],
      tempRead: plan["Temp Read Blocks"],
      tempWritten: plan["Temp Written Blocks"],
    },
    ...(plan.Plans ?? []).flatMap(nodes),
  ];
}

/** Only read-only SELECTs. No write is repeated by EXPLAIN ANALYZE. Values/conditions are omitted. */
export async function explain(runtime: BenchRuntime, samples: readonly QuerySample[]) {
  const seen = new Set<string>();
  const plans: object[] = [];

  for (const sample of samples) {
    if (!/^\s*(?:--[^\n]*\n\s*)*SELECT\b/i.test(sample.text) || /\bFOR\s+(?:UPDATE|SHARE)\b/i.test(sample.text))
      continue;

    if (seen.has(sample.text)) continue;
    seen.add(sample.text);

    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<{ "QUERY PLAN": { Plan: Plan; "Execution Time": number }[] }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sample.text}`,
          [...sample.params],
        );
      }),
    );

    const plan = rows[0]!["QUERY PLAN"][0]!;
    plans.push({ statement: seen.size, executionMs: plan["Execution Time"], nodes: nodes(plan.Plan) });
  }

  return plans;
}
