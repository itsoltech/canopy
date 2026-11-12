import { create } from "@bufbuild/protobuf";
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
};

/** Owner-scoped durable progress. Never read transcript content, routes, credentials or exception details. */
export function readRangeDiagnostics(runtime: CoreRuntime, owner: string, request: ui.ThreadSyncDiagnosticsRequest) {
  const after = request.after ? /^([a-f0-9]{64}):([a-f0-9-]{36})$/.exec(request.after) : undefined;

  // A stale or malformed diagnostics page token restarts a bounded read; it never widens owner scope.
  const limit = Math.min(request.pageSize || 50, 100);

  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<DiagnosticRow>`WITH progress AS (
      SELECT coalesce(s.origin_node_id,f.origin_node_id) AS node,coalesce(s.thread_id,f.thread_id)::text AS thread,
        coalesce(s.applied_seq,0) AS applied,coalesce(s.head_seq,0) AS head,f.reason,f.code,f.retryable,f.frame_bytes,
        coalesce(f.failed_at,CURRENT_TIMESTAMP) AS observed
      FROM thread_range_state s FULL JOIN thread_range_failures f ON s.owner_user_id=f.owner_user_id
        AND s.origin_node_id=f.origin_node_id AND s.thread_id=f.thread_id
      WHERE coalesce(s.owner_user_id,f.owner_user_id)=${owner}::uuid)
      SELECT p.node,p.thread,coalesce(nullif(c.display_name,''),c.name,'The other computer') AS computer,
        p.applied::text,p.head::text,p.reason,p.code,p.retryable,p.frame_bytes::text AS bytes,
        (extract(epoch FROM p.observed)*1000)::bigint::text AS observed
      FROM progress p JOIN computer_peers c ON c.owner_user_id=${owner}::uuid AND c.node_id=p.node
      WHERE (p.node,p.thread)>(${after?.[1] ?? ""},${after?.[2] ?? ""})
      ORDER BY p.node,p.thread LIMIT ${limit + 1}`;

      const totals = (yield* sql<{ remaining: string; syncing: number; failed: number }>`SELECT
      coalesce((SELECT sum(greatest(head_seq-applied_seq,0))::text FROM thread_range_state WHERE owner_user_id=${owner}::uuid),'0') AS remaining,
      (SELECT count(*)::integer FROM thread_range_state WHERE owner_user_id=${owner}::uuid AND head_seq>applied_seq) AS syncing,
      (SELECT count(*)::integer FROM thread_range_failures WHERE owner_user_id=${owner}::uuid) AS failed`)[0]!;

      const selected = rows.slice(0, limit);
      const last = selected.at(-1);

      return create(ui.ThreadSyncDiagnosticsSchema, {
        entries: selected.map((row) => {
          const applied = BigInt(row.applied);
          const head = BigInt(row.head);

          return {
            threadId: qualifyId(row.thread, row.node),
            computerName: row.computer,
            appliedSeq: applied,
            headSeq: head,
            remaining: head > applied ? head - applied : 0n,
            caughtUp: applied === head && !row.reason,
            reason: row.reason ? sanitizedRangeReason(row.reason) : "",
            code: row.code ?? 0,
            retryable: row.retryable ?? false,
            frameBytes: Number(row.bytes ?? 0),
            observedAtMs: BigInt(row.observed || "0"),
          };
        }),
        next: rows.length > limit && last ? `${last.node}:${last.thread}` : "",
        remaining: BigInt(totals.remaining),
        syncingThreads: totals.syncing,
        failedThreads: totals.failed,
      });
    }),
  );
}
