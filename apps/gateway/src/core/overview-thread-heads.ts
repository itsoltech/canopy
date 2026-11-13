import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { isEntityId, splitId } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "./core.ts";
import { coreState } from "./core-context.ts";
import { queryFamily } from "../diagnostics/query-context.ts";

/** Bounded scalar reads only. A mirror advertises its committed, visible checkpoint. */
export async function overviewThreadHeads(core: GatewayCore, ids: readonly string[]) {
  if (ids.length > 32 || ids.some((id) => !isEntityId(id)))
    throw new ConnectError("At most 32 thread IDs are allowed", Code.InvalidArgument);
  const requested = [...new Set(ids)].map((key) => ({ key, ...splitId(key) }));
  const { runtime, userId } = core[coreState].options;

  const rows = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql<{ key: string; epoch: string; seq: string }>`
        WITH requested AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(requested)}::jsonb)
          AS p(key text,id uuid,node text))
        SELECT p.key,coalesce(c.epoch::text,'') AS epoch,coalesce(c.head_seq,0)::text AS seq FROM requested p
          JOIN threads t ON t.id=p.id LEFT JOIN thread_replication_clock c ON c.thread_id=t.id
          WHERE p.node IS NULL AND t.owner_user_id=${userId}::uuid
            AND t.deleted_at IS NULL AND t.status<>'archived'
        UNION ALL
        SELECT p.key,s.visible_epoch::text AS epoch,s.visible_applied_seq::text AS seq FROM requested p
          JOIN thread_range_state s ON s.thread_id=p.id AND left(s.origin_node_id,16)=p.node
          JOIN computer_peers peer ON peer.node_id=s.origin_node_id AND peer.owner_user_id=s.owner_user_id
          WHERE s.owner_user_id=${userId}::uuid AND s.visible_epoch IS NOT NULL`;
    }).pipe(queryFamily("thread.read")),
  );

  return create(ui.ThreadHeadsSchema, {
    heads: rows.map((row) => ({ threadId: row.key, epoch: row.epoch, appliedSeq: BigInt(row.seq) })),
  });
}

/** Exactly one bounded probe per overview stream; unchanged heads send no payload. */
export function followOverviewHeads(
  core: GatewayCore,
  ids: readonly string[],
  signal: AbortSignal,
  send: (update: ui.OverviewUpdate) => void,
  fail: (cause: unknown) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous = "";
  let closed = false;

  const poll = async () => {
    try {
      const heads = await overviewThreadHeads(core, ids);
      const signature = heads.heads.map((head) => `${head.threadId}:${head.epoch}:${head.appliedSeq}`).join(",");

      if (closed || signal.aborted) return;

      if (signature !== previous) {
        previous = signature;
        send(create(ui.OverviewUpdateSchema, { change: { case: "threadHeads", value: heads } }));
      }

      timer = setTimeout(() => void poll(), 2000);
    } catch (cause) {
      if (!closed && !signal.aborted) fail(cause);
    }
  };

  if (ids.length) void poll();

  return () => {
    closed = true;
    clearTimeout(timer);
  };
}
