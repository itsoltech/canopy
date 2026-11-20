import type { computerLink as link } from "@canopy/contracts";
import type { MoveKind } from "./redirect-ids.ts";
import type { ComputerStore } from "./store.ts";

export type RedirectRow = {
  item_id: string;
  kind: MoveKind;
  home_node_id: string;
  home_name: string;
  from_node_id: string;
  moved_at: Date;
  basis: "local_move" | "former_home";
};

/** The caller has authenticated the former home. Its notice can update only that home's own edge. */
export function recordRedirects(store: ComputerStore, items: readonly link.MovedItem[]) {
  const json = JSON.stringify(
    items.map((item) => ({
      item_id: item.itemId,
      kind: item.kind,
      home_node_id: item.homeNodeId,
      home_name: item.homeName.slice(0, 120),
      from_node_id: item.fromNodeId,
      moved_at: new Date(Number(item.movedAtMs)).toISOString(),
    })),
  );

  return store.query<RedirectRow>(
    `WITH input AS MATERIALIZED (
      SELECT r.position,v.* FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY r(value,position)
      CROSS JOIN LATERAL jsonb_to_record(r.value) AS v(item_id uuid,kind text,home_node_id text,
        home_name text,from_node_id text,moved_at timestamptz)
    ), changed AS (
      INSERT INTO computer_redirects(owner_user_id,item_id,kind,home_node_id,home_name,from_node_id,moved_at,basis)
      SELECT $1::uuid,item_id,kind,home_node_id,home_name,from_node_id,moved_at,'former_home' FROM input
      ON CONFLICT(owner_user_id,kind,item_id,from_node_id) DO UPDATE SET home_node_id=excluded.home_node_id,
        home_name=excluded.home_name,moved_at=excluded.moved_at
        WHERE computer_redirects.basis='former_home' AND computer_redirects.moved_at<excluded.moved_at
        RETURNING *
    ) SELECT c.* FROM changed c JOIN input i USING(kind,item_id,from_node_id) ORDER BY i.position`,
    [store.owner, json],
  );
}

/** Keep historical navigation. The former home's completed call does not authorize callbacks at the new one. */
export function followRedirects(store: ComputerStore, items: readonly link.MovedItem[]) {
  const json = JSON.stringify(
    items.map((i) => ({ item: i.itemId, kind: i.kind, home: i.homeNodeId, former: i.fromNodeId })),
  );

  return store.query(
    `UPDATE computer_agent_calls c SET peer_node_id=r.home,detached=true,report_status='dropped'
      FROM jsonb_to_recordset($2::jsonb) AS r(item uuid,kind text,home text,former text)
      WHERE c.owner_user_id=$1::uuid AND c.target_id=r.item AND c.target_kind=r.kind
        AND c.direction='outgoing' AND c.peer_node_id=r.former AND c.result IS NOT NULL`,
    [store.owner, json],
  );
}
