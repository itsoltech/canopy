import { ui } from "@canopy/contracts";
import { coalesceDeltas } from "#lib/server/coalesce.ts";
import { gateway } from "#lib/server/gateway.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";
import { create } from "@bufbuild/protobuf";

/**
 * A bounded recent window, then sequence batches. Reconnects resume the applied checkpoint.
 */
export const GET: RequestHandler = async ({ request, params, url }) => {
  const cursor = (url.searchParams.get("cursor") ?? "").slice(0, 128);
  const parsed = /^range:([a-f0-9-]{36}):(\d{1,20})$/.exec(cursor);
  const seq = parsed && BigInt(parsed[2]!) <= 18446744073709551615n ? parsed : null;

  return sseResponse(
    request,
    async function* (signal) {
      yield* coalesceDeltas(
        gateway().watchThread(
          {
            threadId: params.threadId,
            pageSize: url.searchParams.get("smaller") === "1" ? 8 : 24,
            sequence: true,
            ...(seq && {
              syncCursor: create(ui.ThreadSyncCursorSchema, {
                threadId: params.threadId,
                epoch: seq[1]!,
                appliedSeq: BigInt(seq[2]!),
              }),
            }),
            incremental: url.searchParams.get("incremental") === "1",
            cursor: (url.searchParams.get("cursor") ?? "").slice(0, 128),
            fromTurnId: (url.searchParams.get("from") ?? "").slice(0, 128),
            historyVersion: (url.searchParams.get("version") ?? "").slice(0, 128),
          },
          { signal, timeoutMs: 0 },
        ),
      );
    },
    (update) => encode(ui.ThreadUpdateSchema, update),
  );
};
