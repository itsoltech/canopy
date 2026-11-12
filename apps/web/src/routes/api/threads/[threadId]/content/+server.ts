import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { gateway } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import type { RequestHandler } from "./$types";

/** One bounded content range; authorization is the same as the thread watch. */
export const POST: RequestHandler = async ({ request, params }) => {
  const input = await readMessage(request, ui.ThreadSyncContentRequestSchema);

  const chunk = await gateway().getThreadSyncContent(
    { ...input, threadId: params.threadId },
    { signal: request.signal },
  );

  return new Response(toBinary(ui.ThreadSyncContentChunkSchema, chunk), {
    headers: { "content-type": "application/protobuf", "cache-control": "private, no-store" },
  });
};
