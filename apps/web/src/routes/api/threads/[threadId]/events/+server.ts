import { ui } from "@open-agents/contracts";
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
export const GET: RequestHandler = ({ request, params }) =>
  sseResponse(
    request,
    (signal) => coalesceDeltas(gateway().watchThread({ threadId: params.threadId }, { signal })),
    (update) => encode(ui.ThreadUpdateSchema, update),
  );
