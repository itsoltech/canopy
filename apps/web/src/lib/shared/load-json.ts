import { error } from "@sveltejs/kit";
import { isJsonObject, isString, bodyJson, type JsonValue } from "./json.ts";

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
