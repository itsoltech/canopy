import type { GatewayCoreOptions } from "../core/core.ts";
import { DiagnosticsStore } from "./store.ts";

export class WorkerCatalog {
  values: readonly { id: string; name: string; supported: boolean; measured: boolean }[] = [];
  limited = false;
  #at = 0;
  #loading = false;
  constructor(readonly options: GatewayCoreOptions) {}

  async refresh() {
    if (this.#loading || Date.now() - this.#at < 30_000) return;
    this.#loading = true;

    try {
      const values = await new DiagnosticsStore(this.options.runtime, this.options.userId, "local").query<{
        id: string;
        name: string;
        supported: boolean;
        measured: boolean;
      }>(
        `SELECT id,name,coalesce((capabilities->>'diagnosticsV1')::boolean,false) AS supported,
         coalesce((capabilities->>'workerDiagnosticsV1')::boolean,false) AS measured FROM workers
         WHERE owner_user_id=$1::uuid AND archived_at IS NULL AND revoked_at IS NULL ORDER BY name LIMIT 257`,
        [this.options.userId],
      );

      this.limited = values.length > 256;
      this.values = values.slice(0, 256);
      this.#at = Date.now();
    } catch {
      /* Keep the last owner-scoped catalog during a database outage. */
    } finally {
      this.#loading = false;
    }
  }
}
