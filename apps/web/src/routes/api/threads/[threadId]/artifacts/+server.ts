import { json } from "@sveltejs/kit";
import { ItemSchema } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params, request }) =>
  call(async (api) => {
    const items = [];

    for await (const batch of api.listThreadArtifacts(
      { threadId: params.threadId },
      { signal: request.signal, timeoutMs: 0 },
    )) {
      for (const item of batch.items) items.push(encode(ItemSchema, item));
    }

    return json({ items }, { headers: { "cache-control": "private, no-store" } });
  });
