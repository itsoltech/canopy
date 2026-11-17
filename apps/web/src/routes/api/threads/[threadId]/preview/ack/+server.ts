import { json } from "@sveltejs/kit";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, ui.AckAgentPreviewRequestSchema);
  const input = create(ui.AckAgentPreviewRequestSchema, { ...body, threadId: params.threadId });
  const result = await call((api) => api.ackAgentPreview(input, { signal: request.signal, timeoutMs: 8_000 }));

  return json(encode(ui.WorkerOperationResponseSchema, result));
};
