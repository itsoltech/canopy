import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, request }) =>
  json(
    encode(
      ui.ThreadGitStatusResponseSchema,
      await call((api) =>
        api.getThreadGitStatus({ threadId: params.threadId }, { signal: request.signal, timeoutMs: 40_000 }),
      ),
    ),
    { headers: { "cache-control": "no-store" } },
  );

export const POST: RequestHandler = async ({ params }) =>
  json(
    encode(
      ui.ThreadGitStatusResponseSchema,
      await call((api) => api.pullThreadOrigin({ threadId: params.threadId }, { timeoutMs: 130_000 })),
    ),
    { headers: { "cache-control": "no-store" } },
  );
