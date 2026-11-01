import { error, fail } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { attempt, call, failed } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, parent }) => {
  const { overview } = await parent();
  // Without an overview (gateway down) ListThreads below raises the outage instead of a false 404.
  if (overview && !(overview as { projects?: { id?: string }[] }).projects?.some((p) => p.id === params.projectId)) error(404, "Project not found");
  const response = await call((api) => api.listThreads({ projectId: params.projectId }));
  return { threads: encode(ui.ListThreadsResponseSchema, response) };
};

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

export const actions: Actions = {
  createWorkspace: async ({ request, params }) => {
    const form = await request.formData();
    const workerId = text(form, "workerId");
    const rootPath = text(form, "rootPath");
    if (!workerId || !rootPath) return fail(400, { action: "workspace", error: "Choose a worker and a directory" });
    const result = await attempt("workspace", (api) =>
      api.createWorkspace({ projectId: params.projectId, workerId, rootPath, label: text(form, "label") }),
    );
    if (failed(result)) return result;
    return { action: "workspace", ok: true };
  },
  updateWorkspace: async ({ request }) => {
    const form = await request.formData();
    const workspaceId = text(form, "workspaceId");
    const rootPath = text(form, "rootPath");
    if (!workspaceId || !rootPath) return fail(400, { action: "workspace", error: "Choose a directory" });
    const result = await attempt("workspace", (api) => api.updateWorkspace({ workspaceId, rootPath }));
    if (failed(result)) return result;
    return { action: "workspace", ok: true };
  },
  removeWorkspace: async ({ request }) => {
    const form = await request.formData();
    const workspaceId = text(form, "workspaceId");
    if (!workspaceId) return fail(400, { action: "workspace", error: "Choose a workspace" });
    const result = await attempt("workspace", (api) => api.removeWorkspace({ workspaceId }));
    if (failed(result)) return result;
    return { action: "workspace", ok: true };
  },
};
