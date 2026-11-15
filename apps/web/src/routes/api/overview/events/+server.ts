import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { bffSession } from "#lib/server/bff-session.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Live overview (workers, projects, thread statuses) as SSE. */
export const GET: RequestHandler = async ({ request, url }) => {
  const session = bffSession();
  await call(() => session.overview.overview());

  return sseResponse(
    request,
    (signal) =>
      session.subscribe(
        (url.searchParams.get("heads") ?? "").split(",").filter(Boolean).slice(0, 32),
        url.searchParams.get("active") ?? "",
        signal,
      ),
    (event) => {
      if (event.kind === "read-model") return event.projection;
      const update = encode(ui.OverviewUpdateSchema, event.update);

      return event.update.change.case === "mobileSnapshot" ? { revision: event.revision, update } : update;
    },
    (event) =>
      event.kind === "read-model"
        ? "read-model"
        : event.update.change.case === "mobileSnapshot"
          ? "overview-snapshot"
          : "",
  );
};
