import { ui } from "@canopy/contracts";
import { isEntityId } from "@canopy/domain/computers";
import { call } from "#lib/server/gateway.ts";
import { bffSession } from "#lib/server/bff-session.ts";
import { sseResponse } from "#lib/server/sse.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/**
 * Live overview (workers, projects, thread statuses) as SSE. The first event names the subscription; the tab
 * changes its thread selection with `PUT /api/overview/events/{id}` instead of reopening the stream.
 */
export const GET: RequestHandler = async ({ request, url }) => {
  const session = bffSession();
  await call(() => session.overview.overview());

  return sseResponse(
    request,
    (signal) =>
      session.subscribe(
        (url.searchParams.get("heads") ?? "").split(",").filter(isEntityId).slice(0, 32),
        url.searchParams.get("active") ?? "",
        signal,
      ),
    (event) => {
      if (event.kind === "read-model") return event.projection;

      if (event.kind === "subscription") return { id: event.id };
      const update = encode(ui.OverviewUpdateSchema, event.update);

      return event.update.change.case === "mobileSnapshot" ? { revision: event.revision, update } : update;
    },
    (event) =>
      event.kind === "subscription"
        ? "overview-subscription"
        : event.kind === "read-model"
          ? "read-model"
          : event.update.change.case === "mobileSnapshot"
            ? "overview-snapshot"
            : "",
  );
};
