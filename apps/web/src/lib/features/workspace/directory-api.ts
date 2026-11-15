import { ThreadDirectoryPageSchema } from "@canopy/contracts";
import type { WorkspaceFileApi } from "@canopy/domain/workspace-file";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

export const listDirectory: NonNullable<WorkspaceFileApi["listDirectory"]> = async (request, signal) => {
  return decode(
    ThreadDirectoryPageSchema,
    await requestJson(
      "POST",
      `/api/threads/${encodeURIComponent(request.threadId ?? "")}/directory`,
      {
        directory: request.directory ?? "",
        pageToken: request.pageToken ?? "",
        knownRevision: request.knownRevision ?? "",
        includeIgnored: request.includeIgnored ?? false,
        release: request.release ?? false,
      },
      12_000,
      signal,
    ),
  );
};
