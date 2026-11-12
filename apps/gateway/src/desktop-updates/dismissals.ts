import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";

/** Owner's acknowledgement survives a gateway restart before the app receives its dismissal. */
export class AppUpdateDismissals {
  private cached: Promise<string> | undefined;
  constructor(
    private readonly runtime: CoreRuntime,
    private readonly owner: string,
  ) {}

  read() {
    const owner = this.owner;

    return (this.cached ??= this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const rows = yield* sql<{ request_id: string | null }>`SELECT settings->>'appUpdateDismissal' AS request_id
        FROM user_settings WHERE user_id = ${owner}::uuid`;

        return rows[0]?.request_id ?? "";
      }),
    ));
  }

  async write(requestId: string) {
    const owner = this.owner;
    const value = JSON.stringify({ appUpdateDismissal: requestId });
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO user_settings (user_id, settings, version) VALUES (${owner}::uuid, ${value}::jsonb, 1)
        ON CONFLICT (user_id) DO UPDATE SET settings = user_settings.settings || EXCLUDED.settings, updated_at = now()`;
      }),
    );
    this.cached = Promise.resolve(requestId);
  }
}
