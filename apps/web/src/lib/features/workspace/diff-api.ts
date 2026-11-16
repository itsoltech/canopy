import { ThreadDiffPageSchema, ThreadDiffSnapshotSchema } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

export { ThreadDiffError, ThreadDiffLineKind } from "@canopy/contracts";

export type { ThreadDiffSnapshot, ThreadDiffFile, ThreadDiffPage, ThreadDiffLine } from "@canopy/contracts";

export async function listThreadDiff(threadId: string, signal?: AbortSignal) {
  return decode(
    ThreadDiffSnapshotSchema,
    await requestJson("POST", `/api/threads/${encodeURIComponent(threadId)}/diff`, {}, 45_000, signal),
  );
}

export async function readThreadDiff(
  threadId: string,
  snapshotId: string,
  path: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
) {
  return decode(
    ThreadDiffPageSchema,
    await requestJson(
      "POST",
      `/api/threads/${encodeURIComponent(threadId)}/diff/read`,
      { snapshotId, path, offset, limit },
      12_000,
      signal,
    ),
  );
}
