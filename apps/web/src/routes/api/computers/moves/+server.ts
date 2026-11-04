import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Stage 8 of docs/linked-computers.md: moves of this computer's threads and bots to a linked computer. */
const headers = { "cache-control": "no-store" };

export const GET: RequestHandler = async ({ url }) =>
  json(
    encode(ui.MovesSnapshotSchema, await call((api) => api.getMoves({ batchId: url.searchParams.get("batch") ?? "" }))),
    { headers },
  );

/** The preview of a move: what moves, what has to be done again, and what blocks it. */
export const PUT: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.MovePreviewRequestSchema);

  return json(encode(ui.MovePreviewSchema, await call((api) => api.previewMove(body, { timeoutMs: 30_000 }))), {
    headers,
  });
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.StartMoveRequestSchema);

  return json(encode(ui.MovesSnapshotSchema, await call((api) => api.startMove(body, { timeoutMs: 30_000 }))), {
    headers,
  });
};
