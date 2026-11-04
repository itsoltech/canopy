import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/**
 * Provider CLIs on workers (docs/provider-cli.md): `install` starts an install or update (the gateway checks owner,
 * method and running turns), `check` refreshes the latest versions and asks workers to report again (up to a minute).
 */
export const POST: RequestHandler = async ({ params, request }) => {
  if (params.action === "install") {
    const body = await readMessage(request, ui.InstallCliRequestSchema);

    return json(encode(ui.InstallCliResponseSchema, await call((api) => api.installCli(body, { timeoutMs: 70_000 }))));
  }

  if (params.action === "check") {
    const body = await readMessage(request, ui.CheckCliUpdatesRequestSchema);

    return json(
      encode(ui.CheckCliUpdatesResponseSchema, await call((api) => api.checkCliUpdates(body, { timeoutMs: 70_000 }))),
    );
  }

  error(404, "unknown action");
};
