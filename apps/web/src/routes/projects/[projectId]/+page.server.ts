import { error, fail, redirect } from "@sveltejs/kit";
import { PermissionMode, Provider, ui } from "@open-agents/contracts";
import { attempt, call, failed } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, parent }) => {
  const { overview } = await parent();
  const projects = (overview as { projects?: { id?: string }[] }).projects ?? [];
  if (!projects.some((p) => p.id === params.projectId)) error(404, "Project not found");
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

  createThread: async ({ request, params }) => {
    const form = await request.formData();
    const workspaceId = text(form, "workspaceId");
    if (!workspaceId) return fail(400, { action: "thread", error: "Choose a workspace" });
    const mode = text(form, "permissionMode") as keyof typeof PermissionMode;
    if (!(mode in PermissionMode)) return fail(400, { action: "thread", error: "Unknown permission mode" });
    const result = await attempt("thread", (api) =>
      api.createThread({
        projectId: params.projectId,
        workspaceId,
        title: text(form, "title"),
        provider: Provider.CODEX,
        providerProfileId: text(form, "profileId"),
        model: text(form, "model"),
        permissionMode: PermissionMode[mode],
        initialMessage: text(form, "message"),
        clientRequestId: text(form, "clientRequestId") || crypto.randomUUID(),
      }),
    );
    if (failed(result)) return result;
    redirect(303, `/threads/${result.thread?.id}`);
  },
};
