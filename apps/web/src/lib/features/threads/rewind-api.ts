import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

type Action =
  | { action: "rewind"; turnId: string; clientRequestId: string; restoreFiles: boolean; stopRunning: boolean }
  | { action: "read" | "restore"; rewindId: string };

const path = (threadId: string) => `/api/threads/${encodeURIComponent(threadId)}/rewind`;

export async function previewRewind(threadId: string, turnId: string) {
  return decode(ui.ThreadRewindPreviewSchema, await requestJson("POST", path(threadId), { action: "preview", turnId }));
}

export async function changeRewind(threadId: string, action: Action) {
  return decode(ui.ThreadRewindResponseSchema, await requestJson("POST", path(threadId), action));
}

export type RewindAction = Action;
