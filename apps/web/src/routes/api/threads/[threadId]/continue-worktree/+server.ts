import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { WORKTREE_CLIENT_TIMEOUT_MS } from "@canopy/domain/worktree-timing";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({ baseRef: Schema.String, clientRequestId: Schema.String });

export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readBody(request, Body);

  return json(
    encode(
      ui.CreateThreadResponseSchema,
      await call((api) =>
        api.continueThreadInWorktree({ threadId: params.threadId, ...body }, { timeoutMs: WORKTREE_CLIENT_TIMEOUT_MS }),
      ),
    ),
  );
};
