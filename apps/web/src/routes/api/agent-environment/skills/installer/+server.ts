import { json } from "@sveltejs/kit";
import { SkillInstallerResultSchema, ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.RunSkillInstallerRequestSchema);
  const result = await call((api) => api.runSkillInstaller(body, { timeoutMs: 15_000 }));

  return json(encode(SkillInstallerResultSchema, result), { headers: { "Cache-Control": "no-store" } });
};
