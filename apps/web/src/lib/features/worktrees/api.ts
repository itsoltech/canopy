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

export async function listWorktrees(
  request: MessageInitShape<typeof ui.ListWorktreesRequestSchema>,
): Promise<ui.ListWorktreesResponse> {
  const body = encode(ui.ListWorktreesRequestSchema, create(ui.ListWorktreesRequestSchema, request));

  return decode(ui.ListWorktreesResponseSchema, await requestJson("POST", "/api/worktrees", body, 125_000));
}

export async function cleanupWorktrees(
  projectId: string,
  workerId: string,
  dryRun: boolean,
): Promise<ui.ListWorktreesResponse> {
  const body = encode(
    ui.CleanupWorktreesRequestSchema,
    create(ui.CleanupWorktreesRequestSchema, { projectId, workerId, dryRun }),
  );

  return decode(ui.ListWorktreesResponseSchema, await requestJson("POST", "/api/worktrees/cleanup", body, 305_000));
}

export async function removeWorktree(
  worktreeId: string,
  confirmLocalChanges: boolean,
  expectedHeadCommit: string,
): Promise<ui.WorktreeEntry> {
  const body = encode(
    ui.RemoveWorktreeRequestSchema,
    create(ui.RemoveWorktreeRequestSchema, { worktreeId, confirmLocalChanges, expectedHeadCommit }),
  );

  return decode(ui.WorktreeEntrySchema, await requestJson("DELETE", "/api/worktrees", body, 130_000));
}

export async function revealWorktree(worktreeId: string): Promise<void> {
  const body = encode(ui.RemoveWorktreeRequestSchema, create(ui.RemoveWorktreeRequestSchema, { worktreeId }));
  await requestJson("POST", "/api/worktrees/reveal", body, 30_000);
}
