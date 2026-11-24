export type AcpCleanup = (() => void | Promise<void>) | undefined;

/** Run every cleanup, preserving later resources even when an earlier close fails. */
export async function closeAcpResources(cleanups: readonly AcpCleanup[]): Promise<void> {
  const errors: unknown[] = [];

  for (const cleanup of cleanups) {
    if (!cleanup) continue;

    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) throw errors[0];

  if (errors.length > 1) throw new AggregateError(errors, "ACP resource cleanup failed");
}
