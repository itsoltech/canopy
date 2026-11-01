import { fail, redirect } from "@sveltejs/kit";
import { PermissionMode, Provider } from "@open-agents/contracts";
import { attempt, failed } from "#lib/server/gateway.ts";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

/**
 * Form action body shared by "New thread" (project page) and "New side thread" (thread page):
 * validates the fields, calls CreateThread and redirects to the new thread. Side threads pass
 * `parentThreadId` (and optionally `fork`); the gateway keeps them in the parent's workspace.
 */
export async function createThreadFromForm(form: FormData, projectId: string, action: string) {
  const workspaceId = text(form, "workspaceId");
  if (!workspaceId) return fail(400, { action, error: "Choose a workspace" });
  const mode = text(form, "permissionMode") || "ASK";
  if (!(mode in PermissionMode)) return fail(400, { action, error: "Unknown permission mode" });
  const parentThreadId = text(form, "parentThreadId");
  const initialMessage = text(form, "message");
  if (parentThreadId && !initialMessage) return fail(400, { action, error: "Tell the side thread what to do" });
  const result = await attempt(action, (api) =>
    api.createThread({
      projectId,
      workspaceId,
      title: text(form, "title"),
      provider: Provider.CODEX,
      providerProfileId: text(form, "profileId"),
      model: text(form, "model"),
      permissionMode: PermissionMode[mode as keyof typeof PermissionMode],
      initialMessage,
      parentThreadId,
      fork: Boolean(parentThreadId) && form.get("fork") === "on",
      clientRequestId: text(form, "clientRequestId") || crypto.randomUUID(),
    }),
  );
  if (failed(result)) return result;
  redirect(303, `/threads/${result.thread?.id}`);
}
