import type { ui } from "@canopy/contracts";
import type { Client } from "@connectrpc/connect";

/** Specs of recently shown visuals: at most 16 entries and 2 MiB, least recently used first out (web: same). */
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

/**
 * One version (0 = latest) over the pinned Connect client, read only when it is about to show. Versions are
 * immutable, so hits never refetch; the latest is always read again.
 */
export function loadVisual(
  api: Pick<Client<typeof ui.GatewayService>, "getVisual">,
  threadId: string,
  visualId: string,
  version: number,
): Promise<ui.GetVisualResponse> {
  const key = `${threadId}:${visualId}:${version}`;
  const hit = cache.get(key);

  if (hit) {
    remember(key, hit);

    return Promise.resolve(hit);
  }

  const pending =
    loading.get(key) ??
    api
      .getVisual({ threadId, visualId, version })
      .then((response) => {
        if (version) remember(key, response);

        return response;
      })
      .finally(() => loading.delete(key));

  loading.set(key, pending);

  return pending;
}
