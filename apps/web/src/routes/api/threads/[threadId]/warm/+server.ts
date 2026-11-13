import { json, error } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { gateway } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Finite background transport, with the same owner-scoped bounded sequence reader as the visible watch. */
export const POST: RequestHandler = async ({ params, request }) => {
  const input = await readMessage(request, ui.WatchThreadRequestSchema);
  const abort = new AbortController();
  const updates = [];

  try {
    for await (const update of gateway().watchThread(
      { threadId: params.threadId, sequence: true, background: true, pageSize: 24, syncCursor: input.syncCursor },
      { signal: AbortSignal.any([request.signal, abort.signal]), timeoutMs: 7000 },
    )) {
      if (update.syncStatus?.reason) error(503, "Background thread read unavailable");

      if (update.change.case !== "snapshot" && update.change.case !== "batch") continue;
      updates.push(encode(ui.ThreadUpdateSchema, update));

      if (update.change.case === "snapshot" || update.change.value.caughtUp || updates.length >= 4) break;
    }

    return json(updates, { headers: { "cache-control": "no-store" } });
  } finally {
    abort.abort();
  }
};
