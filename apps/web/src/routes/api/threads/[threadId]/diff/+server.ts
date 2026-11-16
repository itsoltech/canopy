import { json } from "@sveltejs/kit";
import { ThreadDiffSnapshotSchema } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request }) => {
  const snapshot = await call((api) =>
    api.listThreadDiff({ threadId: params.threadId }, { signal: request.signal, timeoutMs: 40_000 }),
  );

  return json(encode(ThreadDiffSnapshotSchema, snapshot));
};
