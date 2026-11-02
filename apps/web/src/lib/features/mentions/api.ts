import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

/** Browser-side lookups for the composer's mention popup (BFF routes under /api/mentions). */

export type MentionScope = MessageInitShape<typeof ui.MentionScopeSchema>;

/** A worker lists its catalog with a harness start (Claude: about a second): longer than the default timeout. */
export async function listMentionCatalog(scope: MentionScope, refresh = false): Promise<ui.ListMentionCatalogResponse> {
  const body = encode(ui.ListMentionCatalogRequestSchema, create(ui.ListMentionCatalogRequestSchema, { scope, refresh }));
  return decode(ui.ListMentionCatalogResponseSchema, await requestJson("POST", "/api/mentions/catalog", body, 50_000));
}

export async function searchFiles(scope: MentionScope, query: string, limit = 50): Promise<ui.SearchFilesResponse> {
  const body = encode(ui.SearchFilesRequestSchema, create(ui.SearchFilesRequestSchema, { scope, query, limit }));
  return decode(ui.SearchFilesResponseSchema, await requestJson("POST", "/api/mentions/files", body, 25_000));
}

export async function searchThreads(query: string, excludeThreadId = "", limit = 20): Promise<ui.SearchThreadsResponse> {
  const body = encode(ui.SearchThreadsRequestSchema, create(ui.SearchThreadsRequestSchema, { query, excludeThreadId, limit }));
  return decode(ui.SearchThreadsResponseSchema, await requestJson("POST", "/api/mentions/threads", body));
}
