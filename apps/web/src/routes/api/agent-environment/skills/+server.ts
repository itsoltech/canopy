import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.SaveLibrarySkillRequestSchema);

  return json(encode(ui.AgentEnvironmentSnapshotSchema, await call((api) => api.saveLibrarySkill(body))), {
    headers: { "Cache-Control": "no-store" },
  });
};

export const DELETE: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.DeleteLibrarySkillRequestSchema);

  return json(encode(ui.AgentEnvironmentSnapshotSchema, await call((api) => api.deleteLibrarySkill(body))), {
    headers: { "Cache-Control": "no-store" },
  });
};
