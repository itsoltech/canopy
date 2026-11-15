import type { ComputerStore } from "./store.ts";
import { LAST_USED_AGENT_SELECT } from "../store/composer-choice-select.ts";

/** Refresh the mirrored overview only when the small latest-user choice itself changes. */
export async function lastUsedAgentKey(store: Pick<ComputerStore, "owner" | "query">): Promise<string> {
  const rows = await store.query<{ key: string }>(
    `SELECT md5(row_to_json(choice)::text) AS key FROM (${LAST_USED_AGENT_SELECT}) choice`,
    [store.owner],
    "mirrors.read",
  );

  return rows[0]?.key ?? "";
}
