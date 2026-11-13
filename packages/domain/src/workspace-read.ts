import type { DirectoryQueue } from "./workspace-directory-queue.ts";

/** Directory pages and document revalidation share the same two interactive read slots. */
export async function workspaceRead<T>(queue: DirectoryQueue, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const release = await queue.acquire(signal);

  try {
    signal.throwIfAborted();

    return await run();
  } finally {
    release();
  }
}
