import { fail, redirect } from "@sveltejs/kit";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { attempt, failed } from "#lib/server/gateway.ts";
import { mentionsFromWire } from "#lib/features/mentions/wire.ts";
import { isProviderKey, providerKeyOf } from "../providers.ts";
import { isPermissionModeName } from "../labels.ts";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

const WORKSPACE_MODES = ["CHECKOUT", "NEW_WORKTREE", "EXISTING_WORKTREE"] as const;

const isWorkspaceModeName = (value: string): value is (typeof WORKSPACE_MODES)[number] =>
  WORKSPACE_MODES.some((mode) => mode === value);

/**
 * Form action body shared by the new-thread and new-side-thread composers:
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

  if (!isPermissionModeName(mode)) return fail(400, { action, error: "Unknown permission mode" });
  const requested = text(form, "provider");
  const provider = parent ? providerKeyOf(parent.provider) : isProviderKey(requested) ? requested : undefined;

  if (!provider) return fail(400, { action, error: "Choose Claude, Codex or Grok" });
  const profileId = parent?.providerProfileId ?? text(form, "profileId");
  const message = String(form.get("message") ?? "");
  const initialMessage = message.trimStart().startsWith("!") ? message.trimEnd() : message.trim();

  if (parent && !initialMessage && form.getAll("attachmentId").length === 0)
    return fail(400, { action, error: "Tell the side thread what to do" });
  const workspaceMode = text(form, "workspaceMode") || "CHECKOUT";

  if (!isWorkspaceModeName(workspaceMode)) return fail(400, { action, error: "Unknown workspace" });
  let initialMentions;

  try {
    initialMentions = mentionsFromWire(form.get("mentions"));
  } catch {
    return fail(400, { action, error: "The message's mentions could not be read" });
  }

  const result = await attempt(action, (api) =>
    api.createThread(
      {
        projectId,
        workspaceId,
        title: text(form, "title"),
        provider: Provider[provider],
        providerProfileId: profileId,
        model: text(form, "model"),
        effort: text(form, "effort"),
        permissionMode: PermissionMode[mode],
        initialMessage,
        parentThreadId: parent?.id ?? "",
        fork: Boolean(parent) && form.get("fork") === "on",
        clientRequestId: text(form, "clientRequestId") || crypto.randomUUID(),
        initialAttachmentIds: form.getAll("attachmentId").map(String).filter(Boolean),
        initialMentions,
        // Side threads work in their parent's directory (and worktree).
        ...(!parent && {
          workspaceMode: ui.WorkspaceMode[workspaceMode],
          baseRef: text(form, "baseRef"),
          worktreeId: text(form, "worktreeId"),
        }),
      },
      { timeoutMs: 100_000 },
    ),
  );

  if (failed(result)) return result;
  redirect(303, `/threads/${result.thread?.id}`);
}
