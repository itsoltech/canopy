import { parseArgs } from "node:util";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { Reactivity } from "effect/reactivity";
import { inspectStorage } from "./maintenance/storage-inspection.ts";
import { reclaimSelectionError, reclaimStorage, RECLAIM_TABLES, StorageReclaimRefused } from "./maintenance/reclaim.ts";

const USAGE = `Usage:
  canopy-gateway storage inspect
  canopy-gateway storage reclaim --offline --table NAME [--table NAME ...]

inspect prints relation sizes in bytes and estimated live/dead tuples as JSON.
reclaim rewrites selected tables with VACUUM FULL; stop the gateway and block reconnection first.
Allowed tables: ${RECLAIM_TABLES.join(", ")}`;

interface StorageOutput {
  readonly out: (line: string) => void;
  readonly error: (line: string) => void;
}

/** One-shot operator command: no migrations, application services, or supervisor. */
export async function storageCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: StorageOutput = { out: console.log, error: console.error },
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "help")) {
    output.out(USAGE);

    return 0;
  }

  const [action, ...rest] = args;
  let tables: string[] = [];
  let offline = false;

  try {
    if (action === "reclaim") {
      const { values } = parseArgs({
        args: rest,
        options: { offline: { type: "boolean" }, table: { type: "string", multiple: true } },
        strict: true,
        allowPositionals: false,
      });

      tables = values.table ?? [];
      offline = values.offline ?? false;
      const problem = reclaimSelectionError(offline, tables);

      if (problem) {
        output.error(problem);

        return 64;
      }
    } else if (action !== "inspect" || rest.length) {
      output.error(USAGE);

      return 64;
    }
  } catch {
    // Do not echo arbitrary arguments: an operator may have accidentally passed credentials.
    output.error(USAGE);

    return 64;
  }

  const url = env["CANOPY_DATABASE_URL"];

  if (!url) {
    output.error("CANOPY_DATABASE_URL is required; load it from the operator environment.");

    return 78;
  }

  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.makeClient({
            url: Redacted.make(url),
            applicationName: "canopy-storage",
            connectTimeout: "5 seconds",
            startupParameters: {
              search_path: "pg_catalog",
              lock_timeout: "2s",
              statement_timeout: action === "inspect" ? "30s" : "0",
              default_transaction_read_only: action === "inspect" ? "on" : "off",
            },
          });

          return action === "inspect" ? yield* inspectStorage(sql) : yield* reclaimStorage(sql, offline, tables);
        }),
      ).pipe(
        Effect.provide(Reactivity.layer),
        Effect.match({
          onSuccess: (report) => {
            output.out(JSON.stringify(report, null, 2));

            return 0;
          },
          onFailure: (error) => {
            output.error(
              error instanceof StorageReclaimRefused
                ? error.message
                : "Storage command failed (connection, permissions, lock timeout, or PostgreSQL error). Completed tables remain reclaimed; inspect before retrying.",
            );

            return 1;
          },
        }),
      ),
    );
  } catch {
    // Driver defects can contain credentials or server details; never print their cause or stack.
    output.error("Storage command failed; no database connection details were printed.");

    return 1;
  }
}
