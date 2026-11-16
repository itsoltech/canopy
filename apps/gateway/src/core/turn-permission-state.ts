import type { CoreRuntime } from "./core-context.ts";

interface PermissionChange {
  turnId: string;
  settled: Promise<void>;
}

const changes = new WeakMap<CoreRuntime, Map<string, PermissionChange>>();
const revisions = new WeakMap<CoreRuntime, number>();
const mutations = new WeakMap<CoreRuntime, Map<string, Promise<void>>>();

/** Fence mode changes and permission-dependent mutations before either acquires a database lock. */
export function withTurnPermissionMutation<A>(
  runtime: CoreRuntime,
  threadId: string,
  perform: () => Promise<A>,
): Promise<A> {
  let queue = mutations.get(runtime);

  if (!queue) {
    queue = new Map();
    mutations.set(runtime, queue);
  }

  const result = (queue.get(threadId) ?? Promise.resolve()).then(perform);

  const settled = result.then(
    () => {},
    () => {},
  );

  queue.set(threadId, settled);
  void settled.then(() => {
    if (queue.get(threadId) === settled) queue.delete(threadId);
  });

  return result;
}

export function permissionsChanged(runtime: CoreRuntime): void {
  revisions.set(runtime, (revisions.get(runtime) ?? 0) + 1);
}

export function permissionChanges(runtime: CoreRuntime): Map<string, PermissionChange> {
  let current = changes.get(runtime);

  if (!current) {
    current = new Map();
    changes.set(runtime, current);
  }

  return current;
}

/** Gateway tool authorization waits until the worker's mode has been committed. */
export async function waitTurnPermissions(runtime: CoreRuntime, threadId: string, turnId: string): Promise<void> {
  for (;;) {
    const change = permissionChanges(runtime).get(threadId);

    if (!change || change.turnId !== turnId) return;
    await change.settled;
  }
}

/** A switch that overlaps the read invalidates its authorization snapshot. */
export async function readTurnPermissions<A>(
  runtime: CoreRuntime,
  threadId: string,
  turnId: string,
  read: () => Promise<A>,
): Promise<A> {
  for (;;) {
    await waitTurnPermissions(runtime, threadId, turnId);
    const revision = revisions.get(runtime) ?? 0;
    const result = await read();

    if (revision === (revisions.get(runtime) ?? 0) && permissionChanges(runtime).get(threadId)?.turnId !== turnId)
      return result;
  }
}
