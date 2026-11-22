import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import { memoryScopes } from "@canopy/domain/memory-scopes";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  const value = url.searchParams.get("scope") ?? "all";
  const option = memoryScopes.find((item) => item.value === value);

  if (!option) error(400, "Unknown memory scope");

  const response = await call((api) =>
    api.listMemoryNotes({ scope: option.scope, cursor: url.searchParams.get("cursor") ?? "", limit: 40 }),
  );

  return json(encode(ui.ListMemoryNotesResponseSchema, response), { headers: { "cache-control": "no-store" } });
};
