import { json } from "@sveltejs/kit";
import { call } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";

/** Archives the owner's project with its workspaces and threads; history and files on the workers stay. */
export const POST: RequestHandler = async ({ params }) => {
  await call((api) => api.archiveProject({ projectId: params.projectId }, { timeoutMs: 60_000 }));

  return json({});
};
