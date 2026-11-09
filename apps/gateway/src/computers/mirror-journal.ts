import type { ComputerStore } from "./store.ts";

/** The PK makes count == revision span a continuity check; coalesce keys before crossing SQL. */
export async function mirrorJournal(store: ComputerStore, from: string, to: string) {
  return (
    await store.query<{ count: string; threads: (string | null)[] }>(
      `SELECT count(*)::text AS count,coalesce(array_agg(DISTINCT thread_id),'{}'::uuid[]) AS threads
      FROM computer_thread_changes WHERE owner_user_id=$1::uuid AND revision>$2::bigint AND revision<=$3::bigint`,
      [store.owner, from, to],
    )
  )[0]!;
}
