import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** `?action=cancel` or `?action=retry`. */
export const POST: RequestHandler = async ({ params, url }) => {
  const action = url.searchParams.get("action");

  if (action !== "cancel" && action !== "retry") error(400, "Choose cancel or retry.");

  const job = await call((api) =>
    action === "cancel"
      ? api.cancelWorkspaceCopyJob({ id: params.id }, { timeoutMs: 30_000 })
      : api.retryWorkspaceCopyJob({ id: params.id }),
  );

  return json(encode(ui.WorkspaceCopyJobSchema, job));
};

/** Removes a finished copy from the list. */
export const DELETE: RequestHandler = async ({ params }) => {
  await call((api) => api.dismissWorkspaceCopyJob({ id: params.id }));

  return json({});
};
