import { json } from "@sveltejs/kit";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ url, request }) =>
  call(async (api) => {
    const input = {
      os: url.searchParams.get("os") ?? "linux",
      arch: url.searchParams.get("arch") ?? "x64",
      metadataOnly: true,
    };

    async function metadata(channelFallback: boolean) {
      for await (const chunk of api.fetchWorkerInstall(
        { ...input, channelFallback },
        { signal: request.signal, timeoutMs: 30_000 },
      )) {
        return {
          version: chunk.version,
          sha256: chunk.sha256,
          downloadUrl: chunk.downloadUrl,
          fallback: channelFallback,
        };
      }

      throw new Error("Release metadata unavailable");
    }

    let value;

    try {
      value = await metadata(false);
    } catch {
      value = await metadata(true);
    }

    return json(value, { headers: { "cache-control": "no-store" } });
  });
