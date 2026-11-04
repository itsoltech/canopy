import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

/** Browser side of git worktrees (docs/worktrees.md): BFF routes under /api/worktrees. */

export async function worktreeSettings(projectId: string, workerId: string): Promise<ui.WorktreeSettingsResponse> {
  const body = encode(
    ui.GetWorktreeSettingsRequestSchema,
    create(ui.GetWorktreeSettingsRequestSchema, { projectId, workerId }),
  );

  return decode(ui.WorktreeSettingsResponseSchema, await requestJson("POST", "/api/worktrees/settings", body));
}

export async function saveWorktreeSettings(
  request: MessageInitShape<typeof ui.UpdateWorktreeSettingsRequestSchema>,
): Promise<ui.WorktreeSettingsResponse> {
  const body = encode(ui.UpdateWorktreeSettingsRequestSchema, create(ui.UpdateWorktreeSettingsRequestSchema, request));

  return decode(ui.WorktreeSettingsResponseSchema, await requestJson("PUT", "/api/worktrees/settings", body));
}

export async function listGitRefs(workspaceId: string): Promise<ui.ListGitRefsResponse> {
  const body = encode(ui.ListGitRefsRequestSchema, create(ui.ListGitRefsRequestSchema, { workspaceId }));

  return decode(ui.ListGitRefsResponseSchema, await requestJson("POST", "/api/worktrees/refs", body, 25_000));
}
