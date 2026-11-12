import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

const filesPath = (threadId: string) => `/api/threads/${encodeURIComponent(threadId)}/files`;

/** Calls wait on the worker (30 s in the gateway). */
const TIMEOUT_MS = 40_000;

export async function readFile(
  threadId: string,
  path: string,
  itemId = "",
  expectedSha256 = "",
): Promise<ui.ThreadFile> {
  const query = new URLSearchParams({ path, itemId, expectedSha256 });

  return decode(
    ui.ThreadFileSchema,
    await requestJson("GET", `${filesPath(threadId)}?${query}`, undefined, TIMEOUT_MS),
  );
}

export async function writeFile(
  threadId: string,
  path: string,
  text: string,
  expectedSha256: string,
): Promise<ui.ThreadFile> {
  return decode(
    ui.ThreadFileSchema,
    await requestJson("PUT", filesPath(threadId), { path, text, expectedSha256 }, TIMEOUT_MS),
  );
}

export async function deleteFile(threadId: string, path: string, expectedSha256: string): Promise<void> {
  await requestJson("DELETE", filesPath(threadId), { path, expectedSha256 }, TIMEOUT_MS);
}

/** The worker's computer opens the file in its default app. */
export async function openFile(threadId: string, path: string): Promise<void> {
  await requestJson("POST", `${filesPath(threadId)}/open`, { path }, TIMEOUT_MS);
}
