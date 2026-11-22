import { fail } from "@sveltejs/kit";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { mentionsFromWire } from "#lib/features/mentions/wire.ts";
import { isProviderKey, providerKeyOf } from "../providers.ts";
import { isPermissionModeName } from "../labels.ts";
import { create, fromJsonString } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { normalizeSandboxProfile, sandboxProfileIdentity } from "@canopy/domain/sandbox-profiles";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

const WORKSPACE_MODES = ["CHECKOUT", "NEW_WORKTREE", "EXISTING_WORKTREE"] as const;

const isWorkspaceModeName = (value: string): value is (typeof WORKSPACE_MODES)[number] =>
  WORKSPACE_MODES.some((mode) => mode === value);

/**
 * Parses the same fields for form actions and background thread creation jobs.
 * - Main thread: `projectId`, `workspaceId` and `provider` come from the form; the gateway checks that
 *   the workspace's worker offers the provider and profile.
 * - Side thread: pass the parent; project, workspace and provider come from the parent (GetThread), so a
 *   fork keeps the provider its history is written in.
 */
export function parseThreadForm(form: FormData, action: string, target: { projectId: string } | { parent: ui.Thread }) {
  const parent = "parent" in target ? target.parent : undefined;
  const projectId = parent?.projectId ?? ("projectId" in target ? target.projectId : "");
  const workspaceId = parent?.workspaceId ?? text(form, "workspaceId");

  if (!projectId) return fail(400, { action, error: "Choose a project" });

  if (!parent && !String(form.get("message") ?? "").trim() && form.getAll("attachmentId").length === 0)
    return fail(400, { action, error: "Tell the agent what to do" });

  if (!workspaceId) return fail(400, { action, error: "Choose a worker" });
  const mode = text(form, "permissionMode") || "ASK";

  if (!isPermissionModeName(mode)) return fail(400, { action, error: "Unknown permission mode" });
  const requested = text(form, "provider");
  const provider = parent ? providerKeyOf(parent.provider) : isProviderKey(requested) ? requested : undefined;

  if (!provider) return fail(400, { action, error: "Choose Claude, Codex or Grok" });
  const profileId = parent?.providerProfileId ?? text(form, "profileId");
  // Browser form encoding expands LF to CRLF. Inline ranges in JSON still index the editor's LF text.
  const message = String(form.get("message") ?? "").replaceAll("\r\n", "\n");
  const initialMessage = message.trimStart().startsWith("!") ? message.trimEnd() : message.trim();

  if (parent && !initialMessage && form.getAll("attachmentId").length === 0)
    return fail(400, { action, error: "Tell the side thread what to do" });
  const workspaceMode = text(form, "workspaceMode") || "CHECKOUT";

  if (!isWorkspaceModeName(workspaceMode)) return fail(400, { action, error: "Unknown workspace" });
  let initialMentions;
  let content: ui.ComposerDraftContent;
  let draftRevision: bigint;

  try {
    initialMentions = mentionsFromWire(form.get("mentions"));
    content = fromJsonString(ui.ComposerDraftContentSchema, text(form, "composerContent") || "{}");
    const revision = text(form, "draftRevision") || "0";

    if (!/^\d{1,20}$/.test(revision))
      return fail(400, { action, error: "Could not read this draft. Reload the page, then retry." });
    draftRevision = BigInt(revision);

    if (draftRevision > 18_446_744_073_709_551_615n)
      return fail(400, { action, error: "Could not read this draft. Reload the page, then retry." });
  } catch {
    return fail(400, { action, error: "The message's mentions could not be read" });
  }

  const sandboxProfileId = text(form, "sandboxProfileId");
  const profile = content.sandboxProfile;
  let sandboxProfileDigest = "";

  if (profile || sandboxProfileId) {
    if (!profile || profile.id !== sandboxProfileId || mode !== "FULL_AUTO")
      return fail(400, { action, error: "The sandbox profile changed. Select it again before sending." });

    try {
      sandboxProfileDigest = createHash("sha256")
        .update(sandboxProfileIdentity(normalizeSandboxProfile(profile)))
        .digest("hex");
    } catch {
      return fail(400, { action, error: "The sandbox profile could not be read. Select it again before sending." });
    }
  }

  return create(ui.CreateThreadRequestSchema, {
    projectId,
    workspaceId,
    title: text(form, "title"),
    provider: Provider[provider],
    providerProfileId: profileId,
    model: text(form, "model"),
    effort: text(form, "effort"),
    serviceTier: text(form, "serviceTier"),
    permissionMode: PermissionMode[mode],
    sandboxProfileId,
    sandboxProfileDigest,
    initialMessage,
    initialQuotes: content.quotes,
    draftId: text(form, "draftId"),
    draftRevision,
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
  });
}
