import { github } from "@canopy/contracts";
import { gateway } from "#lib/server/gateway.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ request, url }) =>
  sseResponse(
    request,
    (signal) =>
      gateway().watchPullRequest(
        {
          pullRequestId: (url.searchParams.get("id") ?? "").slice(0, 100),
          revision: (url.searchParams.get("revision") ?? "").slice(0, 64),
          visibility: "view",
        },
        { signal, timeoutMs: 0 },
      ),
    (value) => encode(github.PullRequestUpdateSchema, value),
  );
