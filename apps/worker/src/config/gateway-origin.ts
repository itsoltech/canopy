import { isIPv4 } from "node:net";

/** All credential-bearing worker transports use the same locally configured trust boundary. */
export function trustedGatewayOrigin(raw: string, trustedHttpOrigin: string | undefined): boolean {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;

  if (url.protocol === "https:") return true;

  if (url.protocol !== "http:") return false;
  const host = url.hostname;

  return (
    host === "localhost" ||
    host === "[::1]" ||
    (isIPv4(host) && host.startsWith("127.")) ||
    url.origin === trustedHttpOrigin
  );
}

export const GATEWAY_TRANSPORT_MESSAGE =
  "Use HTTPS for the worker gateway. For a protected HTTP tunnel or isolated network, set CANOPY_WORKER_TRUSTED_HTTP_ORIGIN to its exact origin.";
