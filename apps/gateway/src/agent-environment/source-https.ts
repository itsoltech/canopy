import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Code, ConnectError } from "@connectrpc/connect";
import { publicSourceAddress } from "./source-address.ts";
import { sourceInvalid } from "./source-command.ts";

export interface WebsiteTransport {
  signal?: AbortSignal;
  /** In-process test fixture only. Production always connects to the validated HTTPS origin. */
  fixtureWebsite?: (origin: string) => URL | undefined;
}

export async function websiteReader(url: URL, transport: WebsiteTransport) {
  const signal = AbortSignal.any([...(transport.signal ? [transport.signal] : []), AbortSignal.timeout(120_000)]);
  const fixture = transport.fixtureWebsite?.(url.origin);
  const address = fixture?.hostname ?? (await publicSourceAddress(url, signal));
  const send = fixture?.protocol === "http:" ? httpRequest : httpsRequest;

  return (path: string, maxBytes: number, index = false) =>
    new Promise<Buffer | undefined>((resolve, reject) => {
      const request = send(
        {
          hostname: address,
          port: (fixture ?? url).port || undefined,
          ...(!fixture && !isIP(url.hostname) && { servername: url.hostname }),
          path,
          headers: { host: (fixture ?? url).host, "accept-encoding": "identity" },
          agent: false,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        },
        (response) => {
          response.on("error", reject);
          const status = response.statusCode;

          if (index && (status !== 200 || response.headers["content-type"]?.startsWith("text/html"))) {
            resolve(undefined);
            response.destroy();

            return;
          }

          if (status !== 200 || ![undefined, "identity"].includes(response.headers["content-encoding"])) {
            reject(new Error("Website returned an unsupported response."));
            response.destroy();

            return;
          }

          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;

            if (bytes > maxBytes) {
              reject(
                new ConnectError(
                  "Website files exceed the skill import size limit. Choose fewer skills or use smaller files.",
                  Code.InvalidArgument,
                ),
              );
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on("end", () => {
            if (bytes <= maxBytes) resolve(Buffer.concat(chunks, bytes));
          });
          response.on("close", () => {
            if (!response.complete) reject(new Error("Website response ended early."));
          });
        },
      );

      request.on("error", reject);
      request.end();
    }).catch((error) => {
      signal.throwIfAborted();

      // Remote response details and address information stay in the transport.
      if (error instanceof ConnectError) throw error;

      return sourceInvalid("Could not download skill files from this website. Check the source URL and try again.");
    });
}
