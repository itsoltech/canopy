import { fail, redirect } from "@sveltejs/kit";
import { PermissionMode, Provider, type ui } from "@canopy/contracts";
import { attempt, failed } from "#lib/server/gateway.ts";
import { mentionsFromWire } from "#lib/features/mentions/wire.ts";
import { isProviderKey, providerKeyOf } from "../providers.ts";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

/**
 * Form action body shared by "New thread" (home composer) and "New side thread" (thread page):
 * validates the fields, calls CreateThread and redirects to the new thread.
 * - Main thread: `projectId`, `workspaceId` and `provider` come from the form; the gateway checks that
 *   the workspace's worker offers the provider and profile.
 * - Side thread: pass the parent; project, workspace and provider come from the parent (GetThread), so a
 *   fork keeps the provider its history is written in.
 */
export async function createThreadFromForm(
  form: FormData,
  action: string,
  target: { projectId: string } | { parent: ui.Thread },
) {
  const parent = "parent" in target ? target.parent : undefined;
  const projectId = parent?.projectId ?? ("projectId" in target ? target.projectId : "");
  const workspaceId = parent?.workspaceId ?? text(form, "workspaceId");

  if (!workspaceId) return fail(400, { action, error: "Choose a worker" });
  const mode = text(form, "permissionMode") || "ASK";

  if (!(mode in PermissionMode)) return fail(400, { action, error: "Unknown permission mode" });
  const requested = text(form, "provider");
  const provider = parent ? providerKeyOf(parent.provider) : isProviderKey(requested) ? requested : undefined;

  if (!provider) return fail(400, { action, error: "Choose Claude, Codex or Grok" });
  const profileId = text(form, "profileId");
  const initialMessage = text(form, "message");

  if (parent && !initialMessage) return fail(400, { action, error: "Tell the side thread what to do" });
  let initialMentions;

  try {
    initialMentions = mentionsFromWire(form.get("mentions"));
  } catch {
    return fail(400, { action, error: "The message's mentions could not be read" });
  }

  const result = await attempt(action, (api) =>
    api.createThread({
      projectId,
      workspaceId,
      title: text(form, "title"),
      provider: Provider[provider],
      providerProfileId: profileId,
      model: text(form, "model"),
      effort: text(form, "effort"),
      permissionMode: PermissionMode[mode as keyof typeof PermissionMode],
      initialMessage,
      parentThreadId: parent?.id ?? "",
      fork: Boolean(parent) && form.get("fork") === "on",
      clientRequestId: text(form, "clientRequestId") || crypto.randomUUID(),
      initialAttachmentIds: form.getAll("attachmentId").map(String).filter(Boolean),
      initialMentions,
    }),
  );

  if (failed(result)) return result;
  redirect(303, `/threads/${result.thread?.id}`);
}
