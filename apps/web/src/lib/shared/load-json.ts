import { error } from "@sveltejs/kit";

/** Client route data with the BFF's status preserved for the retryable error view. */
export async function loadJson(fetcher: typeof fetch, path: string): Promise<unknown> {
  const response = await fetcher(path, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  }).catch(() => error(503, "The gateway is not available"));

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message = (body as { message?: unknown } | null)?.message;
    error(response.status, typeof message === "string" ? message : "The gateway is not available");
  }

  return body;
}
