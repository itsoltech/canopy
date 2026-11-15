import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { StorageSampler, type StorageRoot } from "@canopy/logs/storage";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { isAbsolute, posix, win32 } from "node:path";
import type { CoreRuntime } from "../core/core.ts";

export interface GatewayStorageOptions {
  readonly roots: () => readonly StorageRoot[];
  readonly exclusions?: readonly string[];
  readonly component?: "gateway" | "desktop";
  readonly skip?: (path: string) => boolean;
}

/** Current file sizes have their own cache; performance windows never average or sum them. */
export class GatewayStorage {
  readonly #sampler: StorageSampler | undefined;
  #excluded: readonly string[] = [];
  #value = create(ui.DiagnosticsStorageSchema, { status: "unavailable", component: "gateway" });
  #refresh: Promise<void> | undefined;
  #at = -Infinity;
  #closed = false;

  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
    readonly options?: GatewayStorageOptions,
  ) {
    if (!options) return;
    this.#value = create(ui.DiagnosticsStorageSchema, {
      status: "measuring",
      component: options.component ?? "gateway",
    });
    this.#sampler = new StorageSampler({
      roots: options.roots,
      exclusions: () => [...(options.exclusions ?? []), ...this.#excluded],
      ...(options.skip && { skip: options.skip }),
    });
  }

  snapshot() {
    if (!this.#closed && this.#sampler && !this.#refresh && performance.now() - this.#at >= 60_000) {
      this.#at = performance.now();
      this.#refresh = this.#sample().finally(() => {
        this.#refresh = undefined;
      });
    }

    return create(ui.DiagnosticsStorageSchema, {
      ...this.#value,
      sampleAgeMs: this.#value.sampledAtMs ? Math.max(0, Date.now() - Number(this.#value.sampledAtMs)) : 0,
    });
  }

  async #sample() {
    try {
      const owner = this.owner;
      const desktop = this.options?.component === "desktop";

      const metadata = await this.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET LOCAL statement_timeout='1000ms'`;
              yield* sql`SET LOCAL lock_timeout='100ms'`;

              const database = desktop
                ? []
                : yield* sql<{ bytes: string }>`SELECT pg_database_size(current_database())::text AS bytes`;

              const paths = yield* sql<{ path: string }>`SELECT path FROM (
                SELECT w.root_path AS path FROM project_workspaces w JOIN projects p ON p.id=w.project_id
                WHERE p.owner_user_id=${owner}::uuid
                UNION SELECT cwd AS path FROM threads WHERE owner_user_id=${owner}::uuid AND cwd IS NOT NULL
                UNION SELECT path FROM worktrees WHERE owner_user_id=${owner}::uuid
              ) paths LIMIT 4097`;

              return { database: database[0]?.bytes, paths };
            }),
          );
        }).pipe(Effect.timeout("3 seconds")),
      );

      // An incomplete exclusion list must never turn project files into Canopy runtime data.
      if (metadata.paths.length > 4096) throw new Error("Storage exclusion limit");

      if (
        metadata.paths.some(
          (row) => !isAbsolute(row.path) && !posix.isAbsolute(row.path) && !win32.isAbsolute(row.path),
        )
      )
        throw new Error("Storage exclusion path");
      // Metadata also includes workspaces on workers running a different operating system.
      this.#excluded = metadata.paths.map((row) => row.path).filter(isAbsolute);
      const files = await this.#sampler!.refresh();
      const bytes = metadata.database && /^\d+$/.test(metadata.database) ? BigInt(metadata.database) : undefined;

      if (!desktop && (bytes === undefined || bytes > BigInt(Number.MAX_SAFE_INTEGER)))
        throw new Error("Storage size unavailable");

      if (!this.#closed)
        this.#value = create(ui.DiagnosticsStorageSchema, {
          status: !desktop && files.status === "unavailable" ? "partial" : files.status,
          component: this.options?.component ?? "gateway",
          sampledAtMs: BigInt(files.sampledAtMs),
          categories: [
            ...files.categories,
            ...(!desktop && bytes !== undefined ? [{ category: "database", bytes }] : []),
          ],
        });
    } catch {
      if (!this.#closed)
        this.#value = create(ui.DiagnosticsStorageSchema, {
          ...this.#value,
          status: this.#value.sampledAtMs > 0n ? "partial" : "unavailable",
        });
    }
  }

  close() {
    this.#closed = true;
    this.#sampler?.close();
  }
}
