import { json } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) =>
  json(
    encode(
      bots.ListBotApprovalRulesResponseSchema,
      await call((api) => api.listBotApprovalRules({ botId: params.botId })),
    ),
  );
