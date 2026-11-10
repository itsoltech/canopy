import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) =>
  json(
    encode(
      ui.GetWorkspaceCloneSourceResponseSchema,
      await call((api) => api.getWorkspaceCloneSource({ workspaceId: params.workspaceId })),
    ),
  );
