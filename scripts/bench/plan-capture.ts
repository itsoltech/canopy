import { Effect } from "effect";
import type { SqlConnection } from "effect/sql";
import { createHash } from "node:crypto";
import { nodes, type Plan } from "./explain.ts";
import { normalizedSql, sqlSourceIndex } from "./sql-inventory.ts";

/** Owned benchmark connections only. Capture before execution, while its FK/lock context still exists. */
export class PlanCapture {
  readonly seen = new Set<string>();
  readonly plans: object[] = [];

  constructor(readonly locate?: (text: string) => readonly { file: string; line: number }[]) {}

  capture(connection: SqlConnection.Connection, text: string, params: readonly unknown[], inTransaction: boolean) {
    if (this.seen.has(text) || !/^\s*(?:--[^\n]*\n\s*)*(?:SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(text))
      return Effect.void;
    this.seen.add(text);
    const fingerprint = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const metadata = { fingerprint };

    // Session state and sequences are not undone by savepoint rollback.
    if (
      /\b(?:pg_(?:(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?|notify|cancel_backend|terminate_backend)|nextval|setval|set_config)\s*\(/i.test(
        text,
      )
    ) {
      this.plans.push({ ...metadata, skipped: "nontransactional side effect" });

      return Effect.void;
    }

    const execute = (query: string, bindings: readonly unknown[] = []) =>
      connection.executeUnprepared(query, bindings, undefined);

    return Effect.uninterruptible(
      Effect.gen({ self: this }, function* () {
        const sources = this.locate
          ? this.locate(text)
          : ((yield* Effect.promise(sqlSourceIndex)).get(normalizedSql(text)) ?? []);

        yield* execute(inTransaction ? "SAVEPOINT canopy_bench_plan" : "BEGIN");

        const result = yield* Effect.result(
          connection.executeUnprepared(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, params, undefined),
        );

        // Also recover an aborted statement before the original operation executes.
        yield* execute(inTransaction ? "ROLLBACK TO SAVEPOINT canopy_bench_plan" : "ROLLBACK");

        if (inTransaction) yield* execute("RELEASE SAVEPOINT canopy_bench_plan");

        if (result._tag === "Failure") {
          this.plans.push({ ...metadata, sources, error: result.failure.reason._tag });

          return;
        }

        const rows: readonly {
          "QUERY PLAN": {
            Plan: Plan;
            "Execution Time": number;
            JIT?: {
              Functions: number;
              Timing?: { Total: number };
            };
          }[];
        }[] = result.success;

        const plan = rows[0]!["QUERY PLAN"][0]!;
        this.plans.push({
          ...metadata,
          sources,
          executionMs: plan["Execution Time"],
          ...(plan.JIT && { jit: plan.JIT }),
          nodes: nodes(plan.Plan),
          method: "before original statement; changes and row locks rolled back",
        });
      }),
    );
  }
}
