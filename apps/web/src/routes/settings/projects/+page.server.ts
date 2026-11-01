import { fail, redirect } from "@sveltejs/kit";
import { attempt, failed } from "#lib/server/gateway.ts";
import type { Actions } from "./$types";

export const actions: Actions = {
  createProject: async ({ request }) => {
    const name = String((await request.formData()).get("name") ?? "").trim();
    if (!name) return fail(400, { action: "project", error: "Name is required" });
    const result = await attempt("project", (api) => api.createProject({ name }));
    if (failed(result)) return result;
    redirect(303, `/settings/projects/${result.project?.id}`);
  },
};
