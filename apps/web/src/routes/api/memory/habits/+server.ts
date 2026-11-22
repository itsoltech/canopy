import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ request }) => {
  const snapshot = await call((api) => api.getMemoryHabits({}, { signal: request.signal }));

  return json(encode(ui.MemoryHabitsSnapshotSchema, snapshot), { headers: { "cache-control": "no-store" } });
};

export const PUT: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.UpdateMemoryReflectionRequestSchema);
  const settings = await call((api) => api.updateMemoryReflection(body));

  return json(encode(ui.MemoryReflectionSettingsSchema, settings));
};
