import { error } from "@sveltejs/kit";
import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import { isJsonObject, isString, bodyJson, type JsonValue } from "./json.ts";
import { queries } from "./queries.svelte.ts";
import { decode } from "./wire.ts";

/** Client route data with the BFF's status preserved for the retryable error view. */
export async function loadJson(fetcher: typeof fetch, path: string): Promise<JsonValue> {
  const response = await fetcher(path, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  }).catch(() => error(503, "Could not reach the gateway. Check that it is running, then retry."));

  const body = await bodyJson(response).catch(() => null);

  if (!response.ok) {
    const message = isJsonObject(body) ? body["message"] : undefined;
    error(
      response.status,
      isString(message) ? message : "Could not reach the gateway. Check that it is running, then retry.",
    );
  }

  return body;
}

/**
 * Route data from the tab's shared reads: a current value answers without a request; otherwise the read
 * goes out once and becomes the shared value for the page's components.
 */
export async function loadShared<D extends DescMessage>(
  fetcher: typeof fetch,
  key: string,
  schema: D,
  path: string,
): Promise<MessageShape<D>> {
  const current = queries.snapshot<MessageShape<D>>(key);

  if (current.loaded && !current.stale && current.data) return current.data;
  const value = decode(schema, await loadJson(fetcher, path));
  queries.set(key, value);

  return value;
}
