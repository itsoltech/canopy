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
    throw new Error("Use an HTTPS address from Network access, without a path or credentials.");
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
    // SAFETY: Connect invokes only the Fetch call signature; it never accesses Bun's static preconnect member.
    fetch: ((input, init) =>
      options.fetch(input, { ...init, credentials: "omit", redirect: "error" })) as typeof globalThis.fetch,
    interceptors: [auth],
  });

  return { api: createClient(ui.GatewayService, transport), pairing: createClient(ui.MobilePairingService, transport) };
}

export interface PairingQr {
  type: "canopy-pair";
  version: 2;
  addresses: string[];
  fingerprint: string;
  code: string;
}

function isPairingQr(value: unknown): value is PairingQr {
  return (
    !!value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "canopy-pair" &&
    "version" in value &&
    value.version === 2 &&
    "addresses" in value &&
    Array.isArray(value.addresses) &&
    value.addresses.length > 0 &&
    value.addresses.length <= 32 &&
    value.addresses.every(isGatewayAddress) &&
    "fingerprint" in value &&
    typeof value.fingerprint === "string" &&
    /^[a-f0-9]{64}$/i.test(value.fingerprint) &&
    "code" in value &&
    typeof value.code === "string" &&
    /^[a-f\d\s-]{16,24}$/i.test(value.code)
  );
}

/** Parse untrusted QR/storage addresses at the boundary, before they become route candidates. */
export function isGatewayAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;

  try {
    gatewayOrigin(value);

    return true;
  } catch {
    return false;
  }
}

export function readPairingQr(raw: string) {
  if (raw.length > 8192) throw new Error("This QR code is not a Canopy pairing code.");
  const value: unknown = JSON.parse(raw);

  if (!isPairingQr(value)) {
    throw new Error("Create a new pairing QR code in Settings → Devices and pair again.");
  }

  return {
    addresses: value.addresses.map((a) => gatewayOrigin(a)),
    fingerprint: value.fingerprint.toLowerCase(),
    code: value.code,
  };
}
