import type { ComputerStore } from "./store.ts";

export type RouteSource = "manual" | "lan" | "announced";

export type RouteRow = {
  node_id: string;
  address: string;
  source: RouteSource;
  added_at: Date;
  last_success: Date | null;
  last_failure: Date | null;
  latency_ms: number | null;
};

/** Order in which connecting tries a partner's routes: the most recent success first; a route that
 * failed after its last success goes behind the working ones, so a dead best route costs one try. */
export const ROUTE_ORDER =
  "(last_failure IS NOT NULL AND (last_success IS NULL OR last_failure > last_success)), last_success DESC NULLS LAST, added_at DESC";

// Each source is bounded; the least useful routes of that source go first.
const LIMIT: Record<RouteSource, number> = { manual: 16, announced: 16, lan: 8 };

/** Routes to linked computers (docs/linked-computers.md, stage 6). Unlink removes them by cascade. */
export class Routes {
  constructor(readonly store: ComputerStore) {}
  list(nodeId?: string) {
    return this.store.query<RouteRow>(
      `SELECT * FROM computer_routes WHERE owner_user_id=$1::uuid AND ($2::text IS NULL OR node_id=$2) ORDER BY node_id, ${ROUTE_ORDER}`,
      [this.store.owner, nodeId ?? null],
    );
  }
  /** A manual route keeps its source when found again; any address entered by the user becomes manual. */
  async add(nodeId: string, addresses: string[], source: RouteSource) {
    if (!addresses.length) return;
    await this.store.query(
      `INSERT INTO computer_routes (owner_user_id,node_id,address,source)
      SELECT $1::uuid,$2,address,$4 FROM unnest($3::text[]) AS address WHERE EXISTS (SELECT 1 FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2)
      ON CONFLICT (owner_user_id,node_id,address) DO UPDATE SET source=CASE WHEN excluded.source='manual' THEN 'manual' ELSE computer_routes.source END`,
      [this.store.owner, nodeId, [...new Set(addresses)], source],
    );
    await this.store.query(
      `DELETE FROM computer_routes WHERE (owner_user_id,node_id,address) IN (SELECT owner_user_id,node_id,address FROM computer_routes
      WHERE owner_user_id=$1::uuid AND node_id=$2 AND source=$3 ORDER BY ${ROUTE_ORDER} OFFSET $4)`,
      [this.store.owner, nodeId, source, LIMIT[source]],
    );
  }
  success(nodeId: string, address: string, latencyMs: number) {
    return this.store.query(
      "UPDATE computer_routes SET last_success=now(),latency_ms=$4 WHERE owner_user_id=$1::uuid AND node_id=$2 AND address=$3",
      [this.store.owner, nodeId, address, Math.max(0, Math.round(latencyMs))],
    );
  }
  failure(nodeId: string, address: string) {
    return this.store.query(
      "UPDATE computer_routes SET last_failure=now() WHERE owner_user_id=$1::uuid AND node_id=$2 AND address=$3",
      [this.store.owner, nodeId, address],
    );
  }
  async remove(nodeId: string, address: string) {
    return (
      (
        await this.store.query(
          "DELETE FROM computer_routes WHERE owner_user_id=$1::uuid AND node_id=$2 AND address=$3 RETURNING address",
          [this.store.owner, nodeId, address],
        )
      ).length > 0
    );
  }
  /** Discovery turned off: paths found on a local network are not used any more. */
  forgetLan() {
    return this.store.query("DELETE FROM computer_routes WHERE owner_user_id=$1::uuid AND source='lan'", [
      this.store.owner,
    ]);
  }
}
