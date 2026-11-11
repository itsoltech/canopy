import { create, fromBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore, toUiThread, toUiTurn } from "../store/store.ts";
import { GoalStore, toUiGoal } from "../store/goals.ts";
import { SteerStore, toUiSteer } from "../store/steers.ts";
import { AgentBusStore, toUiDelivery } from "../store/agent-bus.ts";

export type RangeKey = { seq: string; kind: string; entity_id: string };

/** Materialize only the requested public entities, never the complete timeline.
 * The caller holds the per-thread commit barrier until these records are sealed.
 */
export function projectRange(thread: string, keys: readonly RangeKey[]) {
  return Effect.gen(function* () {
    const ids = (kind: string) => keys.flatMap((key) => (key.kind === kind ? [key.entity_id] : []));
    const store = yield* GatewayStore;

    const snapshot = yield* store.snapshot(thread, undefined, false, undefined, {
      itemIds: ids("item"),
      turnIds: ids("turn"),
      noticeSeqs: ids("notice"),
      interactionIds: ids("interaction"),
    });

    const records = new Map<string, ui.ThreadSyncRecord["value"]>();
    const sql = yield* SqlClient.SqlClient;

    const chain = yield* sql<{
      thread_id: string;
      level: number;
    }>`SELECT thread_id,level FROM thread_fork_chain(${thread}::uuid)`;

    const depths = new Map(chain.map((row) => [row.thread_id, BigInt(row.level)]));

    const legacy = yield* sql<{ kind: string; entity_id: string; payload: Uint8Array }>`SELECT kind,entity_id,payload
      FROM thread_replication_seed_entities WHERE thread_id=${thread}::uuid
        AND (kind || ':' || entity_id)=ANY(${keys.flatMap((key) => (key.kind.startsWith("legacy_") ? [`${key.kind}:${key.entity_id}`] : []))}::text[])`;

    const inherited = new Map(
      legacy.map((row) => [`${row.kind}:${row.entity_id}`, fromBinary(ui.ThreadSyncRecordSchema, row.payload)]),
    );

    records.set(`thread:${thread}`, { case: "thread", value: toUiThread(snapshot.thread) });

    for (const turn of snapshot.turns) records.set(`turn:${turn.id}`, { case: "turn", value: toUiTurn(turn) });

    for (const item of snapshot.items)
      if (item.item) records.set(`item:${item.item.itemId}`, { case: "item", value: item });

    for (const notice of snapshot.notices) records.set(`notice:${notice.seq}`, { case: "notice", value: notice });

    for (const interaction of snapshot.interactions)
      records.set(`interaction:${interaction.requestId}`, { case: "interaction", value: interaction });

    if (ids("goal").length) {
      const goals = yield* GoalStore;
      const goal = yield* goals.latest(thread);

      if (goal) records.set(`goal:${thread}`, { case: "goal", value: toUiGoal(goal) });
    }

    if (ids("steer").length) {
      const steers = yield* SteerStore;

      for (const steer of yield* steers.ofThread(thread, ids("steer")))
        records.set(`steer:${steer.id}`, { case: "steer", value: toUiSteer(steer) });
    }

    if (ids("delivery").length) {
      const bus = yield* AgentBusStore;

      for (const delivery of yield* bus.deliveries({ sourceThreadId: thread, callIds: ids("delivery") })) {
        const value = toUiDelivery(delivery);
        records.set(`delivery:${value.callId}`, { case: "busDelivery", value });
      }
    }

    return keys.map((key) => {
      const entity = `${key.kind}:${key.entity_id}`;
      const previous = inherited.get(entity);

      if (previous) return create(ui.ThreadSyncRecordSchema, { ...previous, seq: BigInt(key.seq) });
      const value = records.get(entity);
      let position = BigInt(key.seq);

      if (value?.case === "turn")
        position = BigInt(value.value.ordinal) - (depths.get(value.value.fromThreadId) ?? 0n) * 1_000_000_000n;

      if (value?.case === "item")
        position = value.value.firstSeq - (depths.get(value.value.fromThreadId) ?? 0n) * 1_000_000_000n;

      return create(ui.ThreadSyncRecordSchema, {
        seq: BigInt(key.seq),
        key: entity,
        position,
        ...(value?.case === "item" && value.value.contentRef && { content: value.value.contentRef }),
        removed: !value,
        ...(value && { value }),
      });
    });
  });
}
