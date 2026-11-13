import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

/** Specs of recently shown visuals: at most 16 entries and 2 MiB, least recently used first out. */
const MAX_ENTRIES = 16;
const MAX_BYTES = 2 * 1024 * 1024;
const cache = new Map<string, ui.GetVisualResponse>();
const loading = new Map<string, Promise<ui.GetVisualResponse>>();

function remember(key: string, response: ui.GetVisualResponse): void {
  cache.delete(key);
  cache.set(key, response);
  let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.specJson.length * 2, 0);

  for (const [old, entry] of cache) {
    if (cache.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    cache.delete(old);
    bytes -= entry.specJson.length * 2;
  }
}

export const visualUrl = (threadId: string, visualId: string, version: number) =>
  `/api/threads/${encodeURIComponent(threadId)}/visuals/${encodeURIComponent(visualId)}?version=${version}`;

/** One version (0 = latest), read only when it is about to show. Versions are immutable, so hits never refetch. */
export function loadVisual(threadId: string, visualId: string, version: number): Promise<ui.GetVisualResponse> {
  const key = `${threadId}:${visualId}:${version}`;
  const hit = cache.get(key);

  if (hit) {
    remember(key, hit);

    return Promise.resolve(hit);
  }

  const pending =
    loading.get(key) ??
    requestJson("GET", visualUrl(threadId, visualId, version))
      .then((json) => {
        const response = decode(ui.GetVisualResponseSchema, json);

        if (version) remember(key, response);

        return response;
      })
      .finally(() => loading.delete(key));

  loading.set(key, pending);

  return pending;
}
