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
  /** The partner stopped announcing this address: an old address. */
  withdrawn_at: Date | null;
};

/** Order in which connecting tries a partner's routes: the most recent success first; a route that
 * failed after its last success goes behind the working ones, so a dead best route costs one try.
 * Old addresses go last. */
export const ROUTE_ORDER =
  "withdrawn_at IS NOT NULL, (last_failure IS NOT NULL AND (last_success IS NULL OR last_failure > last_success)), last_success DESC NULLS LAST, added_at DESC";

// Each source is bounded; the least useful routes of that source go first.
const LIMIT: Record<RouteSource, number> = { manual: 16, announced: 16, lan: 8 };

// An old address nobody needs: a current route worked after it was withdrawn, or it has been old this long.
const OLD_ADDRESS_DAYS = 7;

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
      ON CONFLICT (owner_user_id,node_id,address) DO UPDATE SET source=CASE WHEN excluded.source='manual' THEN 'manual' ELSE computer_routes.source END,
        withdrawn_at=CASE WHEN excluded.source IN ('manual','announced') THEN NULL ELSE computer_routes.withdrawn_at END`,
      [this.store.owner, nodeId, [...new Set(addresses)], source],
    );
    await this.store.query(
      `DELETE FROM computer_routes WHERE (owner_user_id,node_id,address) IN (SELECT owner_user_id,node_id,address FROM computer_routes
      WHERE owner_user_id=$1::uuid AND node_id=$2 AND source=$3 ORDER BY ${ROUTE_ORDER} OFFSET $4)`,
      [this.store.owner, nodeId, source, LIMIT[source]],
    );
  }
  /**
   * The partner's complete list of addresses (its hello or a route announcement). Announced addresses missing from it
   * become old addresses: still tried, last, because the partner can be wrong for a moment (a network going down).
   * An empty list (listener off, shutting down) says nothing about where the partner listens next time.
   */
  async announce(nodeId: string, addresses: string[]) {
    await this.add(nodeId, addresses, "announced");

    if (!addresses.length) return;
    await this.store.query(
      `UPDATE computer_routes SET withdrawn_at=now() WHERE owner_user_id=$1::uuid AND node_id=$2 AND source='announced'
      AND withdrawn_at IS NULL AND NOT (address = ANY($3::text[]))`,
      [this.store.owner, nodeId, [...new Set(addresses)]],
    );
    await this.prune(nodeId);
  }
  prune(nodeId: string) {
    return this.store.query(
      `DELETE FROM computer_routes old WHERE owner_user_id=$1::uuid AND node_id=$2 AND source='announced' AND withdrawn_at IS NOT NULL
      AND (withdrawn_at < now() - make_interval(days => $3) OR EXISTS (SELECT 1 FROM computer_routes r
        WHERE r.owner_user_id=old.owner_user_id AND r.node_id=old.node_id AND r.withdrawn_at IS NULL AND r.last_success > old.withdrawn_at))`,
      [this.store.owner, nodeId, OLD_ADDRESS_DAYS],
    );
  }
  /** A route that works is not old, even when the partner stopped announcing it. */
  async success(nodeId: string, address: string, latencyMs: number) {
    await this.store.query(
      "UPDATE computer_routes SET last_success=now(),latency_ms=$4,withdrawn_at=NULL WHERE owner_user_id=$1::uuid AND node_id=$2 AND address=$3",
      [this.store.owner, nodeId, address, Math.max(0, Math.round(latencyMs))],
    );
    await this.prune(nodeId);
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
