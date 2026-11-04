import { error } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { loadJson } from "#lib/shared/load-json.ts";
import { decode } from "#lib/shared/wire.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => {
  const [overview, threads] = await Promise.all([
    loadJson(fetch, "/api/overview"),
    loadJson(fetch, `/api/threads?projectId=${encodeURIComponent(params.projectId)}`),
  ]);

  if (
    !decode(ui.GetOverviewResponseSchema, overview).projects.some(
      (project) => project.id === params.projectId && project.kind !== "scratch",
    )
  )
    error(404, "Project not found");

  return { threads };
};
