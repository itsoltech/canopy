import { ui, type GitRef } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

export async function threadBranches(threadId: string) {
  return decode(
    ui.ListGitRefsResponseSchema,
    await requestJson("GET", `/api/threads/${threadId}/branches`, undefined, 40_000),
  );
}

export async function switchThreadBranch(threadId: string, branch: GitRef) {
  return decode(
    ui.SwitchThreadBranchResponseSchema,
    await requestJson(
      "POST",
      `/api/threads/${threadId}/branches`,
      { branch: branch.name, remote: branch.remote },
      135_000,
    ),
  );
}
