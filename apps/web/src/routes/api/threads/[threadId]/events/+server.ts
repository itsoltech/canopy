import { ui } from "@canopy/contracts";
import { coalesceDeltas } from "#lib/server/coalesce.ts";
import { gateway } from "#lib/server/gateway.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/**
 * One thread as SSE: a snapshot first, then live changes. After a reconnect (EventSource does it
 * automatically) the browser receives a fresh snapshot, so it never has to replay gaps itself. Text
 * deltas go out merged per line (`coalesceDeltas`), not per token.
 */
export const GET: RequestHandler = async ({ request, params, url }) => {
  return sseResponse(
    request,
    async function* (signal) {
      await gateway().getThread({ threadId: params.threadId }, { signal });
      yield* coalesceDeltas(
        gateway().watchThread(
          {
            threadId: params.threadId,
            pageSize: 24,
            incremental: url.searchParams.get("incremental") === "1",
            cursor: (url.searchParams.get("cursor") ?? "").slice(0, 128),
          },
          { signal, timeoutMs: 0 },
        ),
      );
    },
    (update) => encode(ui.ThreadUpdateSchema, update),
  );
};
