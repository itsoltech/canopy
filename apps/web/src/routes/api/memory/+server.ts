import type { MessageInitShape } from "@bufbuild/protobuf";
import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import { memoryScopes } from "@canopy/domain/memory-scopes";
import type { RequestHandler } from "./$types";

async function list(input: MessageInitShape<typeof ui.ListMemoryNotesRequestSchema>) {
  const response = await call((api) => api.listMemoryNotes(input));

  return json(encode(ui.ListMemoryNotesResponseSchema, response), { headers: { "cache-control": "no-store" } });
}

export const GET: RequestHandler = async ({ url }) => {
  const value = url.searchParams.get("scope") ?? "all";
  const option = memoryScopes.find((item) => item.value === value);

  if (!option) error(400, "Unknown memory scope");

  return list({ scope: option.scope, cursor: url.searchParams.get("cursor") ?? "", limit: 40 });
};

// Search terms can include private note content. Keep them out of request URLs.
export const POST: RequestHandler = async ({ request }) => {
  const filters = await readMessage(request, ui.ListMemoryNotesRequestSchema);

  return list({ ...filters, limit: 20, includeFilterOptions: !filters.cursor });
};
