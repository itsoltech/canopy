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
 * Gives up after `timeoutMs` (15 s; longer for calls that wait on a worker).
 */
export async function requestJson(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = 15_000,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message = (payload as { message?: unknown } | null)?.message;
    throw new HttpError(response.status, typeof message === "string" ? message : `Request failed (${response.status})`);
  }

  return payload;
}
