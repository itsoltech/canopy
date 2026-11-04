import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.PreviewAgentEnvironmentRequestSchema);

  return json(
    encode(ui.PreviewAgentEnvironmentResponseSchema, await call((api) => api.previewAgentEnvironment(body))),
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
};
