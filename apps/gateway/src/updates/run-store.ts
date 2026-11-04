import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";

/** The existing private user settings row scopes the run and survives gateway replacement. */
export class UpdateRunStore {
  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
  ) {}

  async read(): Promise<ui.UpdateRun | undefined> {
    const owner = this.owner;

    const rows = await this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{
          run: JsonValue | null;
        }>`SELECT settings->'updateRun' AS run FROM user_settings WHERE user_id = ${owner}::uuid`;
      }),
    );

    return rows[0]?.run ? fromJson(ui.UpdateRunSchema, rows[0].run) : undefined;
  }

  async write(run: ui.UpdateRun): Promise<void> {
    // Internal progress does not invalidate optimistic edits of the user's visible settings.
    const owner = this.owner;
    const value = JSON.stringify({ updateRun: toJson(ui.UpdateRunSchema, run) });
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO user_settings (user_id, settings, version) VALUES (${owner}::uuid, ${value}::jsonb, 1)
        ON CONFLICT (user_id) DO UPDATE SET settings = user_settings.settings || EXCLUDED.settings, updated_at = now()
        WHERE user_settings.settings->'updateRun' IS DISTINCT FROM EXCLUDED.settings->'updateRun'`;
      }),
    );
  }
}
