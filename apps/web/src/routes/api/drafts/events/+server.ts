import { ui } from "@canopy/contracts";
import { call, gateway } from "#lib/server/gateway.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ request, url }) => {
  await call((api) => api.getClientCapabilities({}, { signal: request.signal }));
  const revision = url.searchParams.get("after") ?? "0";

  return sseResponse(
    request,
    (signal) =>
      gateway().watchComposerDrafts(
        { afterRevision: /^\d+$/.test(revision) ? BigInt(revision) : 0n },
        { signal, timeoutMs: 0 },
      ),
    (value) => encode(ui.ComposerDraftChangeSchema, value),
  );
};
