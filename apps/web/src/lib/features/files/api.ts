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
  signal?: AbortSignal,
): Promise<ui.ThreadFile> {
  const query = new URLSearchParams({ path, itemId, expectedSha256 });

  return decode(
    ui.ThreadFileSchema,
    await requestJson("GET", `${filesPath(threadId)}?${query}`, undefined, TIMEOUT_MS, signal),
  );
}

export async function writeFile(
  threadId: string,
  path: string,
  text: string,
  expectedSha256: string,
  expectedRootIdentity = "",
): Promise<ui.ThreadFile> {
  const body = { path, text, expectedSha256, expectedRootIdentity };

  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 512 * 1024)
    throw new Error("These edits exceed the save limit. Reduce the file size, then retry.");

  return decode(ui.ThreadFileSchema, await requestJson("PUT", filesPath(threadId), body, TIMEOUT_MS));
}

export async function deleteFile(
  threadId: string,
  path: string,
  expectedSha256: string,
  expectedRootIdentity = "",
): Promise<void> {
  await requestJson("DELETE", filesPath(threadId), { path, expectedSha256, expectedRootIdentity }, TIMEOUT_MS);
}

/** The worker's computer opens the file in its default app. */
export async function openFile(threadId: string, path: string): Promise<void> {
  await requestJson("POST", `${filesPath(threadId)}/open`, { path }, TIMEOUT_MS);
}
