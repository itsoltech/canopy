import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.ConfigNoticeOperationSchema);

  return json(encode(ui.ComputersSnapshotSchema, await call((api) => api.manageConfigNotice(body))), {
    headers: { "cache-control": "no-store" },
  });
};
