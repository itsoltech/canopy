import { create, fromBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";
import { sanitizedRangeReason } from "./range-failure.ts";

type DiagnosticRow = {
  node: string;
  thread: string;
  computer: string;
  applied: string;
  head: string;
  reason: string | null;
  code: number | null;
  retryable: boolean | null;
  bytes: string | null;
  observed: string;
  metadata: Uint8Array | null;
};

type ComputerRow = {
  node: string;
  name: string;
  hostname: string;
  threads: number;
  caught_up: number;
  behind: number;
  syncing: number;
  paused: number;
  remaining: string;
  synced: string;
};

// Restrict both sides before joining. Failures without a committed range still need attention.
const PROGRESS = `WITH progress AS (
  SELECT coalesce(s.origin_node_id,f.origin_node_id) AS node,coalesce(s.thread_id,f.thread_id) AS thread,
    coalesce(s.applied_seq,0) AS applied,coalesce(s.head_seq,0) AS head,
    f.reason,f.code,f.retryable,f.frame_bytes,f.failed_at,s.last_synced_at
  FROM (SELECT * FROM thread_range_state WHERE owner_user_id=$1::uuid) s
  FULL JOIN (SELECT * FROM thread_range_failures WHERE owner_user_id=$1::uuid) f
    ON s.origin_node_id=f.origin_node_id AND s.thread_id=f.thread_id
)`;

function diagnostic(row: DiagnosticRow) {
  const applied = BigInt(row.applied);
  const head = BigInt(row.head);

  return create(ui.ThreadSyncDiagnosticSchema, {
    threadId: qualifyId(row.thread, row.node),
    computerNodeId: row.node,
    computerName: row.computer,
    threadTitle: row.metadata ? fromBinary(ui.ThreadSchema, row.metadata).title : "",
    appliedSeq: applied,
    headSeq: head,
    remaining: head > applied ? head - applied : 0n,
    caughtUp: applied === head && !row.reason,
    reason: row.reason ? sanitizedRangeReason(row.reason) : "",
    code: row.code ?? 0,
    retryable: row.retryable ?? false,
    frameBytes: Number(row.bytes ?? 0),
    observedAtMs: BigInt(row.observed),
  });
}

/** Local metadata only: summaries never decode threads or contact a linked computer. */
export function readRangeDiagnostics(
  runtime: CoreRuntime,
  owner: string,
  request: ui.ThreadSyncDiagnosticsRequest,
  reachable: readonly string[],
) {
  const after = request.after ? /^([a-f0-9]{64}):([a-f0-9-]{36})$/.exec(request.after) : undefined;
  const limit = Math.min(request.pageSize || 50, 100);

  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const summaries = yield* sql.unsafe<ComputerRow>(
        `${PROGRESS}
        SELECT p.node,coalesce(nullif(c.display_name,''),c.name) AS name,c.name AS hostname,
          count(*)::integer AS threads,
          count(*) FILTER(WHERE p.applied=p.head AND p.reason IS NULL)::integer AS caught_up,
          count(*) FILTER(WHERE p.head>p.applied)::integer AS behind,
          count(*) FILTER(WHERE p.head>p.applied AND p.reason IS NULL)::integer AS syncing,
          count(*) FILTER(WHERE p.reason IS NOT NULL)::integer AS paused,
          sum(greatest(p.head-p.applied,0))::text AS remaining,
          coalesce((extract(epoch FROM max(p.last_synced_at))*1000)::bigint,0)::text AS synced
        FROM progress p JOIN computer_peers c ON c.owner_user_id=$1::uuid AND c.node_id=p.node
        GROUP BY p.node,c.display_name,c.name ORDER BY p.node`,
        [owner],
      );

      const computers = summaries.map((row) =>
        create(ui.ThreadSyncComputerSchema, {
          nodeId: row.node,
          name: row.name,
          hostname: row.hostname,
          reachable: reachable.includes(row.node),
          threads: row.threads,
          upToDateThreads: row.caught_up,
          syncingThreads: row.syncing,
          pausedThreads: row.paused,
          remaining: BigInt(row.remaining),
          lastSyncedAtMs: BigInt(row.synced),
        }),
      );

      const rows = request.summaryOnly
        ? []
        : yield* sql.unsafe<DiagnosticRow>(
            `${PROGRESS}
        SELECT p.node,p.thread::text,coalesce(nullif(c.display_name,''),c.name) AS computer,
          p.applied::text,p.head::text,p.reason,p.code,p.retryable,p.frame_bytes::text AS bytes,
          coalesce((extract(epoch FROM coalesce(p.failed_at,p.last_synced_at))*1000)::bigint,0)::text AS observed,
          t.thread_metadata AS metadata
        FROM progress p JOIN computer_peers c ON c.owner_user_id=$1::uuid AND c.node_id=p.node
        LEFT JOIN computer_mirror_state m ON m.owner_user_id=$1::uuid AND m.origin_node_id=p.node
        LEFT JOIN computer_mirror_threads t ON t.owner_user_id=$1::uuid AND t.origin_node_id=p.node
          AND t.generation=m.generation AND t.thread_id=p.thread
        WHERE (p.node,p.thread::text)>($2,$3) AND ($4='' OR p.node=$4)
          AND (NOT $5::boolean OR p.head>p.applied OR p.reason IS NOT NULL)
        ORDER BY p.node,p.thread LIMIT $6`,
            [owner, after?.[1] ?? "", after?.[2] ?? "", request.computerNodeId, request.attentionOnly, limit + 1],
          );

      const selected = rows.slice(0, limit);
      const last = selected.at(-1);

      return create(ui.ThreadSyncDiagnosticsSchema, {
        entries: selected.map(diagnostic),
        computers,
        next: rows.length > limit && last ? `${last.node}:${last.thread}` : "",
        remaining: computers.reduce((sum, computer) => sum + computer.remaining, 0n),
        syncingThreads: summaries.reduce((sum, row) => sum + row.behind, 0),
        failedThreads: computers.reduce((sum, computer) => sum + computer.pausedThreads, 0),
      });
    }),
  );
}
