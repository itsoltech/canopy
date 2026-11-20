export const THREAD_BLOB_BYTES = 8 * 1024 ** 2;

const PREVIEW_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/x-diff",
  "application/json",
]);

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export function acceptsPreview(threadId: string, digest: string, mimeType: string): boolean {
  return (threadId === "" || UUID.test(threadId)) && SHA256.test(digest) && PREVIEW_TYPES.has(mimeType);
}
