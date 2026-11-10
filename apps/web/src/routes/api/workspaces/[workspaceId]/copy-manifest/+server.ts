import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import { readMessage } from "#lib/server/body.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) =>
  json(
    encode(
      ui.GetWorkspaceCopyManifestResponseSchema,
      await call((api) => api.getWorkspaceCopyManifest({ workspaceId: params.workspaceId }, { timeoutMs: 130_000 })),
    ),
    { headers: { "cache-control": "no-store" } },
  );

export const DELETE: RequestHandler = async ({ request, params }) => {
  const input = await readMessage(request, ui.WorkspaceCopySourceRequestSchema);
  await call((api) => api.workspaceCopySource({ workspaceId: params.workspaceId, token: input.token, release: true }));

  return json({});
};
