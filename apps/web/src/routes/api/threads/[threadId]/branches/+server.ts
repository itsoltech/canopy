import { json } from "@sveltejs/kit";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  branch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  remote: Schema.Boolean,
});

export const GET: RequestHandler = async ({ params }) =>
  json(
    encode(
      ui.ListGitRefsResponseSchema,
      await call((api) => api.listThreadBranches({ threadId: params.threadId }, { timeoutMs: 35_000 })),
    ),
  );

export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readBody(request, Body);

  return json(
    encode(
      ui.SwitchThreadBranchResponseSchema,
      await call((api) => api.switchThreadBranch({ threadId: params.threadId, ...body }, { timeoutMs: 130_000 })),
    ),
  );
};
