import { ui, ThreadFilesUpdateSchema } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { gateway } from "#lib/server/gateway.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** POST keeps bounded multi-path scope out of URLs and access logs. */
export const POST: RequestHandler = async ({ request, params }) => {
  const target = await readMessage(request, ui.WatchThreadFilesRequestSchema);

  return sseResponse(
    request,
    (signal) => gateway().watchThreadFiles({ ...target, threadId: params.threadId }, { signal, timeoutMs: 0 }),
    (update) => encode(ThreadFilesUpdateSchema, update),
  );
};
