import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sourceInvalid } from "./source-command.ts";

function publicAddress(address: string): boolean {
  if (isIP(address) !== 4) return false; // IPv4-only connections avoid mapped IPv6 and local IPv6 ranges.
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);

  return (
    ![0, 10, 127].includes(a) &&
    a < 224 &&
    address !== "168.63.129.16" &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)) || (b === 88 && c === 99))) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113) &&
    !(a === 100 && b >= 64 && b <= 127)
  );
}

export async function publicSourceAddress(url: URL, signal?: AbortSignal) {
  if (url.protocol !== "https:" || url.username || url.password)
    sourceInvalid("Use an HTTPS source without credentials in its URL.");
  const canceled = Promise.withResolvers<never>();
  const stop = () => canceled.reject(new Error("Source DNS lookup canceled."));
  signal?.addEventListener("abort", stop, { once: true });

  try {
    signal?.throwIfAborted();
    const addresses = await Promise.race([lookup(url.hostname, { all: true, family: 4 }), canceled.promise]);
    const first = addresses[0];

    if (!first || addresses.some((a) => !publicAddress(a.address)))
      sourceInvalid("Sources must resolve to public addresses.");

    return first.address;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
