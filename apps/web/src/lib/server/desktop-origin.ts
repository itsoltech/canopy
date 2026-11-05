/** The OAuth return is the only external navigation allowed into the desktop BFF. */
export function trustedDesktopRequest(request: Request, url: URL, origin: string | undefined): boolean {
  if (!origin) return true;
  const headers = request.headers;

  if (headers.get("host") !== new URL(origin).host) return false;
  const mode = headers.get("sec-fetch-mode");
  const destination = headers.get("sec-fetch-dest");

  const callback =
    request.method === "GET" &&
    url.pathname === "/api/connectors/oauth/callback" &&
    (!headers.has("sec-fetch-mode") || mode === "navigate") &&
    (!headers.has("sec-fetch-dest") || destination === "document");

  return (
    callback ||
    ((!headers.has("origin") || headers.get("origin") === origin) && headers.get("sec-fetch-site") !== "cross-site")
  );
}
