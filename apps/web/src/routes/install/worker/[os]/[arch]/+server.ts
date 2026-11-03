import { call } from "#lib/server/gateway.ts";
import { installResponse } from "#lib/server/worker-install.ts";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = ({ params, url, request }) => call(async (api) => {
  if (url.searchParams.has("release")) {
    for await (const chunk of api.fetchWorkerInstall({ os: params.os, arch: params.arch, metadataOnly: true, channelFallback: true }, { signal: request.signal, timeoutMs: 30_000 })) {
      return new Response(`${chunk.downloadUrl}\n${chunk.sha256}\n${chunk.version}\n`, { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    }
    throw new Error("No release metadata");
  }
  return installResponse(api, params.os, params.arch, url.searchParams.has("sha256"), request.signal);
});
