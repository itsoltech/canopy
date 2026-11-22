import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, ui.ResolveMemoryHabitRequestSchema);
  body.habitId = params.habitId;
  await call((api) => api.resolveMemoryHabit(body));

  return new Response(null, { status: 204 });
};
