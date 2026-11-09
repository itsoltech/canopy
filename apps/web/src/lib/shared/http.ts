import { isJsonObject, isString, bodyJson, type JsonValue } from "./json.ts";

/** A request body: JSON values, with fields set to `undefined` left out (as `JSON.stringify` does). */
export type JsonBody =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly JsonBody[]
  | { readonly [key: string]: JsonBody };

/** A BFF call that failed; `status` lets callers tell a conflict (409) from other failures. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Browser-side JSON call to the BFF (same origin); the error message comes from SvelteKit's `{ message }`.
 * Gives up after `timeoutMs` (40 s; longer for calls that wait on a worker).
 */
export async function requestJson(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: JsonBody,
  timeoutMs = 40_000,
): Promise<JsonValue> {
  const response = await fetch(path, {
    method,
    headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const payload = await bodyJson(response).catch(() => null);

  if (!response.ok) {
    const message = isJsonObject(payload) ? payload["message"] : undefined;
    throw new HttpError(response.status, isString(message) ? message : `Request failed (${response.status})`);
  }

  return payload;
}
