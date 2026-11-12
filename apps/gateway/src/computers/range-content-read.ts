import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";
import { rangeResult } from "./range-effects.ts";

/** The full record stays in SQL; neither the DB driver nor HTTP/2 sees an unbounded row. */
export function readRangeContent(runtime: CoreRuntime, owner: string, request: ui.ThreadSyncContentRequest) {
  if (!/^[a-f0-9]{64}$/.test(request.sha256) || request.offset > 2_147_483_646n)
    throw new ConnectError("Invalid thread content range", Code.InvalidArgument);
  const length = Math.min(request.length || 32 * 1024, 48 * 1024);

  return runtime
    .runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const row = (yield* sql<{ data: Uint8Array; size: string }>`SELECT
      substring(c.data FROM ${Number(request.offset) + 1}::integer FOR ${length}::integer) AS data,
      octet_length(c.data)::text AS size FROM thread_replication_content c JOIN threads t ON t.id=c.thread_id
      WHERE c.thread_id=${request.threadId}::uuid AND c.sha256=${request.sha256}
        AND t.owner_user_id=${owner}::uuid AND t.deleted_at IS NULL`)[0];

          if (!row) return yield* Effect.fail(new ConnectError("Thread content not found", Code.NotFound));

          if (request.offset > BigInt(row.size))
            return yield* Effect.fail(new ConnectError("Thread content offset is out of range", Code.OutOfRange));

          return create(ui.ThreadSyncContentChunkSchema, {
            data: row.data,
            offset: request.offset,
            sizeBytes: BigInt(row.size),
          });
        }),
      ),
    )
    .then(rangeResult);
}
