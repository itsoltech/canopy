import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BOT_FILE_BYTES, BotFileError, botFilename, type BotWorkspace } from "./workspace.ts";

const blocked = new BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] satisfies [string, number][])
  blocked.addSubnet(address, prefix, "ipv4");

blocked.addAddress("168.63.129.16", "ipv4");

const globalV6 = new BlockList();

globalV6.addSubnet("2000::", 3, "ipv6");

blocked.addSubnet("2001::", 23, "ipv6");

blocked.addSubnet("2001:db8::", 32, "ipv6");

blocked.addSubnet("2002::", 16, "ipv6");

blocked.addSubnet("3fff::", 20, "ipv6");

export function publicBotAddress(address: string): boolean {
  const family = isIP(address);

  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export interface BotDownloadAddress {
  address: string;
  family: number;
}

export interface BotDownloadResponse {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}

export interface BotDownloadOptions {
  resolve?: (hostname: string) => Promise<BotDownloadAddress[]>;
  connect?: (url: URL, address: BotDownloadAddress, signal: AbortSignal) => Promise<BotDownloadResponse>;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Connect to the validated literal IP. DNS is never consulted again; TLS authenticates the URL's hostname. */
export function connectBotDownload(
  url: URL,
  address: BotDownloadAddress,
  signal: AbortSignal,
): Promise<BotDownloadResponse> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;

    const req = request(
      {
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        servername: url.hostname.replace(/^\[|\]$/g, ""),
        headers: { Host: url.host, Accept: "*/*", "Accept-Encoding": "identity" },
        signal,
        agent: false,
      },
      (response) => {
        const headers = new Headers();

        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);

        response.setTimeout(10_000, () => response.destroy(new BotFileError("The download timed out. Try again.")));
        resolve({ status: response.statusCode ?? 0, headers, body: response, close: () => response.destroy() });
      },
    );

    req.setTimeout(10_000, () => req.destroy(new BotFileError("The download timed out. Try again.")));
    req.once("error", reject);
    req.end();
  });
}

function checkedUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new BotFileError("Use a valid public HTTP or HTTPS URL.");
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new BotFileError("Use a public HTTP or HTTPS URL without credentials or a fragment.");

  return url;
}

async function resolvedAddress(url: URL, signal: AbortSignal, resolve: NonNullable<BotDownloadOptions["resolve"]>) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(new BotFileError("The download timed out or was interrupted. Try again."));

  signal.addEventListener("abort", abort, { once: true });

  try {
    signal.throwIfAborted();

    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([resolve(hostname), cancelled.promise]);

    if (!addresses.length || addresses.some((a) => !publicBotAddress(a.address)))
      throw new BotFileError("This URL is not public. Choose a public download URL.");

    return addresses[0]!;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function downloadBotFile(
  workspace: BotWorkspace,
  value: string,
  filename: string,
  outerSignal: AbortSignal,
  options: BotDownloadOptions = {},
) {
  const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(options.timeoutMs ?? 60_000)]);
  const limit = Math.min(options.maxBytes ?? BOT_FILE_BYTES, BOT_FILE_BYTES);
  const resolve = options.resolve ?? ((host: string) => lookup(host, { all: true }));
  const connect = options.connect ?? connectBotDownload;
  let url = checkedUrl(value);

  if (filename) botFilename(filename);

  for (let redirects = 0; redirects <= 5; redirects++) {
    const address = await resolvedAddress(url, signal, resolve);
    const response = await connect(url, address, signal);

    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");

        if (!location || redirects === 5)
          throw new BotFileError("The download redirected too many times. Use a direct URL.");
        url = checkedUrl(new URL(location, url).href);
        continue;
      }

      if (response.status < 200 || response.status >= 300)
        throw new BotFileError("The download failed. Check the URL, then retry.");
      const length = response.headers.get("content-length");

      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
        throw new BotFileError("The file exceeds the download size limit.");
      const chunks: Uint8Array[] = [];
      let size = 0;

      for await (const chunk of response.body) {
        signal.throwIfAborted();
        size += chunk.byteLength;

        if (size > limit) throw new BotFileError("The file exceeds the download size limit.");
        chunks.push(chunk);
      }

      if (length !== null && size !== Number(length)) throw new BotFileError("The download was incomplete. Try again.");
      signal.throwIfAborted();
      const name = botFilename(filename || decodeURIComponent(url.pathname.split("/").at(-1) || "download.bin"));
      const saved = workspace.write(name, Buffer.concat(chunks));

      return {
        ...saved,
        mime_type: response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
      };
    } finally {
      response.close();
    }
  }

  throw new BotFileError("The download could not finish. Use a direct URL.");
}
