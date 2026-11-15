import { create } from "@bufbuild/protobuf";
import { AgentPreviewEventSchema, ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { gateway } from "#lib/server/gateway.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** The gateway derives the session from this owned thread; disconnecting cancels the ephemeral preview. */
export const POST: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, ui.WatchAgentPreviewRequestSchema);
  const input = create(ui.WatchAgentPreviewRequestSchema, { ...body, threadId: params.threadId });

  return sseResponse(
    request,
    (signal) => gateway().watchAgentPreview(input, { signal, timeoutMs: 0 }),
    (event) => encode(AgentPreviewEventSchema, event),
  );
};
