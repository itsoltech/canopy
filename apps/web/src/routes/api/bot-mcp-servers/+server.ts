import { json } from "@sveltejs/kit";
import { bots } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => json(encode(bots.ListBotMcpServersResponseSchema, await call((api) => api.listBotMcpServers({}))));
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, bots.SaveBotMcpServerRequestSchema);
  return json(encode(bots.SaveBotMcpServerResponseSchema, await call((api) => api.saveBotMcpServer(body))));
};
