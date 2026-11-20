/** Vite serves the owner BFF alongside HMR. SvelteKit checks form origins only in production. */
export function trustedDevRequest(request: Request, url: URL): boolean {
  if (
    request.method === "GET" &&
    url.pathname === "/api/connectors/oauth/callback" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document"
  )
    return true;
  const origin = request.headers.get("origin");

  if (origin !== null) return origin === url.origin;

  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const site = request.headers.get("sec-fetch-site");

  if (site === "same-origin") return true;

  // Non-browser API clients can send JSON without an Origin. A browser needs a successful preflight.
  return (
    site === null && request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json"
  );
}
