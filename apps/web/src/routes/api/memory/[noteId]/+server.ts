import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, ui.UpdateMemoryNoteRequestSchema);
  body.noteId = params.noteId;
  const note = await call((api) => api.updateMemoryNote(body));

  return json(encode(ui.MemoryNoteSchema, note));
};

export const DELETE: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, ui.DeleteMemoryNoteRequestSchema);
  body.noteId = params.noteId;
  await call((api) => api.deleteMemoryNote(body));

  return new Response(null, { status: 204 });
};
