import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  if (params.action === "enable") {
    const body = await readMessage(request, ui.SetAgentToolEnabledRequestSchema);

    return json(
      encode(
        ui.WorkerOperationResponseSchema,
        await call((api) => api.setAgentToolEnabled(body, { signal: request.signal })),
      ),
    );
  }

  if (params.action === "install") {
    const body = await readMessage(request, ui.InstallAgentToolRequestSchema);

    return json(
      encode(
        ui.InstallAgentToolResponseSchema,
        await call((api) => api.installAgentTool(body, { signal: request.signal, timeoutMs: 25_000 })),
      ),
    );
  }

  if (params.action === "refresh") {
    const body = await readMessage(request, ui.RefreshAgentToolsRequestSchema);

    return json(
      encode(
        ui.RefreshAgentToolsResponseSchema,
        await call((api) => api.refreshAgentTools(body, { signal: request.signal, timeoutMs: 40_000 })),
      ),
    );
  }

  if (params.action === "run") {
    const body = await readMessage(request, ui.RunAgentToolRequestSchema);
    const response = await call((api) => api.runAgentTool(body, { signal: request.signal, timeoutMs: 100_000 }));

    return json(encode(ui.RunAgentToolResponseSchema, response));
  }

  error(404, "unknown action");
};
