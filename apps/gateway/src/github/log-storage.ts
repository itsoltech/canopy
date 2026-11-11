import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { Code, ConnectError } from "@connectrpc/connect";

/** Only GitHub Actions' documented result storage; no URL comes from a client/check details link. */
export function storageUrl(value: string) {
  const url = new URL(value);

  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !/^(?:productionresultssa\d+\.blob\.core\.windows\.net|results-receiver\.actions\.githubusercontent\.com)$/.test(
      url.hostname,
    )
  )
    throw new ConnectError("GitHub log storage is unavailable. Retry on GitHub.", Code.Unavailable);

  return url;
}

function publicAddress(address: string) {
  if (address.includes(":")) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0):/i.test(address);
  const [a = 0, b = 0] = address.split(".").map(Number);

  return (
    a > 0 &&
    a < 224 &&
    a !== 10 &&
    a !== 127 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19))
  );
}

/** Pin a verified public address for this TLS request, closing the DNS rebind window. */
export async function fetchLogStorage(url: URL, signal: AbortSignal): Promise<Response> {
  const addresses = await lookup(url.hostname, { all: true });

  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new ConnectError("GitHub log storage is unavailable. Retry on GitHub.", Code.Unavailable);
  const selected = addresses[0]!;

  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        method: "GET",
        headers: { Accept: "text/plain", "Accept-Encoding": "identity" },
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
      },
      (response) => {
        const headers = new Headers();

        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            response.on("data", (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
              response.pause();
            });
            response.on("end", () => controller.close());
            response.on("error", (error) => controller.error(error));
          },
          pull() {
            response.resume();
          },
          cancel() {
            response.destroy();
          },
        });

        resolve(new Response(body, { status: response.statusCode ?? 502, headers }));
      },
    );

    req.on("error", reject);
    req.end();
  });
}
