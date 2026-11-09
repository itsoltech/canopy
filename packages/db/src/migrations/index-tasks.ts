import { Effect, Option } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import type { SqlConnection } from "effect/sql";
import { splitStatements } from "./split.ts";

interface IndexState {
  readonly valid: boolean;
  readonly definition: string;
}

const canonical = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, "")
    .trim()
    .replace(/;$/, "")
    .replace(/\s+/g, " ");

const badState = (message: string) => new Migrator.MigrationError({ kind: "BadState", message });

/** Only non-unique performance indexes may be deferred; constraints stay transactional. */
export function indexTasks(content: string) {
  return splitStatements(content).map((statement) => {
    const definition = canonical(statement);
    const match = /^CREATE INDEX ([a-z][a-z0-9_]*) ON public\.([a-z][a-z0-9_]*) USING btree \(/.exec(definition);

    if (!match) throw new Error("Deferred index files may contain only canonical, non-unique CREATE INDEX statements");

    return { name: match[1]!, definition };
  });
}

type IndexTask = ReturnType<typeof indexTasks>[number];

function build(connection: SqlConnection.Connection, task: IndexTask, concurrent: boolean) {
  return Effect.gen(function* () {
    const rows: readonly IndexState[] = yield* connection.executeUnprepared(
      `SELECT i.indisvalid AS valid, pg_get_indexdef(c.oid) AS definition
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_index i ON i.indexrelid=c.oid WHERE n.nspname='public' AND c.relname=$1`,
      [task.name],
      undefined,
    );

    const existing = rows[0];

    if (existing && canonical(existing.definition) !== task.definition)
      return yield* Effect.fail(
        badState(`Index ${task.name} has an unexpected definition; inspect it before retrying`),
      );

    if (existing?.valid) return;

    if (existing)
      yield* connection.executeUnprepared(
        `DROP INDEX ${concurrent ? "CONCURRENTLY " : ""}public.${task.name}`,
        [],
        undefined,
      );
    const create = task.definition.replace("CREATE INDEX ", `CREATE INDEX ${concurrent ? "CONCURRENTLY " : ""}`);
    yield* connection.executeUnprepared(create, [], undefined);

    const verified: readonly IndexState[] = yield* connection.executeUnprepared(
      `SELECT i.indisvalid AS valid, pg_get_indexdef(c.oid) AS definition
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_index i ON i.indexrelid=c.oid WHERE n.nspname='public' AND c.relname=$1`,
      [task.name],
      undefined,
    );

    if (!verified[0]?.valid || canonical(verified[0].definition) !== task.definition)
      return yield* Effect.fail(badState(`Index ${task.name} did not become valid`));
  });
}

/** A reserved session owns the lock and DDL. No concurrent DDL runs inside a transaction. */
export const runIndexTasks = (tasks: readonly IndexTask[], concurrent: boolean, retired: readonly string[] = []) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* Effect.fail(badState("Index tasks must run outside a transaction"));
      const connection = yield* sql.reserve;

      const lock = yield* Effect.acquireRelease(
        Effect.sync(() => ({ held: false })),
        (state) =>
          state.held
            ? connection.executeUnprepared("SELECT pg_advisory_unlock(183516401, 1)", [], undefined).pipe(Effect.orDie)
            : Effect.void,
      );

      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // A blocking SELECT keeps a snapshot; concurrent builds may wait on it and deadlock with this lock.
          for (;;) {
            const rows: readonly { acquired: boolean }[] = yield* connection.executeUnprepared(
              "SELECT pg_try_advisory_lock(183516401, 1) AS acquired",
              [],
              undefined,
            );

            if (rows[0]?.acquired) {
              lock.held = true;

              return;
            }

            yield* restore(Effect.sleep("50 millis"));
          }
        }),
      );

      for (const task of tasks) yield* build(connection, task, concurrent);

      // Retire superseded indexes only after replacements are valid, including after a failed build/restart.
      for (const name of retired) {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) return yield* Effect.fail(badState("Invalid retired index identifier"));
        yield* connection.executeUnprepared(
          `DROP INDEX ${concurrent ? "CONCURRENTLY " : ""}IF EXISTS public.${name}`,
          [],
          undefined,
        );
      }
    }),
  );
