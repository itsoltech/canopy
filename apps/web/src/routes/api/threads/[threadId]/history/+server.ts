import { json, error } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { gateway } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Read one whole-turn page through the same owner-scoped route as the live watch. */
export const GET: RequestHandler = async ({ params, url, request }) => {
  const abort = new AbortController();

  try {
    for await (const update of gateway().watchThread(
      {
        threadId: params.threadId,
        pageSize: 24,
        beforeTurnId: (url.searchParams.get("before") ?? "").slice(0, 128),
        targetItemId: (url.searchParams.get("target") ?? "").slice(0, 256),
        historyVersion: (url.searchParams.get("version") ?? "").slice(0, 128),
      },
      { signal: AbortSignal.any([request.signal, abort.signal]), timeoutMs: 15000 },
    )) {
      if (update.change.case === "snapshot") return json(encode(ui.ThreadSnapshotSchema, update.change.value));
    }

    error(503, "History unavailable");
  } finally {
    abort.abort();
  }
};
