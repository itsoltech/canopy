import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { ui } from "@canopy/contracts";

export function gatewayOrigin(value: string, development = false): string {
  const url = new URL(value.trim());
  const local = development && ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(url.hostname);

  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use your private Tailscale HTTPS address, without a path or credentials.");
  }

  return url.origin;
}

/** Pure TS: production uses expo/fetch, the Bun integration test injects its real streaming fetch. */
export function mobileClient(options: {
  gatewayUrl: string;
  token?: string;
  fetch: typeof globalThis.fetch;
  development?: boolean;
}) {
  const auth: Interceptor = (next) => (request) => {
    if (options.token) request.header.set("authorization", `Bearer ${options.token}`);

    return next(request);
  };

  const transport = createConnectTransport({
    baseUrl: gatewayOrigin(options.gatewayUrl, options.development),
    useBinaryFormat: true,
    // Never forward browser cookies or follow redirects carrying a bearer token.
    // Bun also declares a static fetch.preconnect; Connect only calls the fetch function itself.
    fetch: ((input, init) =>
      options.fetch(input, { ...init, credentials: "omit", redirect: "error" })) as typeof globalThis.fetch,
    interceptors: [auth],
  });

  return { api: createClient(ui.GatewayService, transport), pairing: createClient(ui.MobilePairingService, transport) };
}

export function readPairingQr(raw: string): { gatewayUrl: string; code: string } {
  if (raw.length > 2048) throw new Error("This QR code is not a Canopy pairing code.");
  const value: unknown = JSON.parse(raw);

  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "canopy-pair" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("gatewayUrl" in value) ||
    typeof value.gatewayUrl !== "string" ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    !/^[a-f\d\s-]{16,24}$/i.test(value.code)
  ) {
    throw new Error("This QR code is not a Canopy pairing code.");
  }

  return { gatewayUrl: value.gatewayUrl, code: value.code };
}
