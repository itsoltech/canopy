import type { computerLink as link } from "@canopy/contracts";
import type { ComputerStore } from "./store.ts";

export type RedirectRow = {
  item_id: string;
  kind: string;
  home_node_id: string;
  home_name: string;
  from_node_id: string;
  moved_at: Date;
};

/** At most 128 distinct IDs; one atomic statement retains the database's timestamp fence. */
export function recordRedirects(store: ComputerStore, items: readonly link.MovedItem[]) {
  const json = JSON.stringify(
    items.map((item) => ({
      item_id: item.itemId,
      kind: item.kind,
      home_node_id: item.homeNodeId,
      home_name: item.homeName.slice(0, 120),
      from_node_id: item.fromNodeId,
      moved_at: new Date(Number(item.movedAtMs) || Date.now()).toISOString(),
    })),
  );

  return store.query<RedirectRow>(
    `WITH input AS MATERIALIZED (
      SELECT r.position,v.* FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY r(value,position)
      CROSS JOIN LATERAL jsonb_to_record(r.value) AS v(item_id uuid,kind text,home_node_id text,
        home_name text,from_node_id text,moved_at timestamptz)
    ), changed AS (
      INSERT INTO computer_redirects(owner_user_id,item_id,kind,home_node_id,home_name,from_node_id,moved_at)
      SELECT $1::uuid,item_id,kind,home_node_id,home_name,from_node_id,moved_at FROM input
      ON CONFLICT(owner_user_id,item_id) DO UPDATE SET kind=excluded.kind,home_node_id=excluded.home_node_id,
        home_name=excluded.home_name,from_node_id=excluded.from_node_id,moved_at=excluded.moved_at
        WHERE computer_redirects.moved_at<=excluded.moved_at RETURNING *
    ) SELECT c.* FROM changed c JOIN input i USING(item_id) ORDER BY i.position`,
    [store.owner, json],
  );
}

/** Distinct target IDs only; repeated moves keep the caller's ordered per-item path. */
export function followRedirects(store: ComputerStore, items: readonly link.MovedItem[]) {
  const json = JSON.stringify(
    items.map((item) => ({ item: item.itemId, home: item.homeNodeId, former: item.fromNodeId })),
  );

  return store.query(
    `UPDATE computer_agent_calls c SET peer_node_id=r.home
      FROM jsonb_to_recordset($2::jsonb) AS r(item uuid,home text,former text)
      WHERE c.owner_user_id=$1::uuid AND c.target_id=r.item AND c.direction='outgoing' AND c.peer_node_id=r.former`,
    [store.owner, json],
  );
}
