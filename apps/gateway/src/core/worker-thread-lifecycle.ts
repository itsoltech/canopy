import type { ThreadRow } from "../store/store.ts";
import type { GatewayCore } from "./core.ts";
import { coreRun } from "./core-broadcast.ts";
import type { WorkerConnection } from "../worker-link/index.ts";

export async function workerThreadSnapshot(core: GatewayCore, workerId: string) {
  return { closedThreadIds: await coreRun(core, (store) => store.closedWorkerThreads(workerId)), replace: true };
}

/** A live delta must never be overwritten by a snapshot read before its commit. */
export async function syncWorkerThreadLifecycle(core: GatewayCore, connection: WorkerConnection) {
  if (!connection.hello.capabilities.includes("thread_lifecycle_v1")) return;

  while (connection.isOpen) {
    const revision = connection.threadLifecycleRevision;
    const snapshot = await workerThreadSnapshot(core, connection.workerId);

    if (revision !== connection.threadLifecycleRevision) continue;
    connection.send({ case: "threadLifecycle", value: snapshot });
    connection.threadLifecycle.clear();

    for (const threadId of snapshot.closedThreadIds) connection.threadLifecycle.set(threadId, true);

    return;
  }
}

/** Every lifecycle entry point broadcasts the committed row, including agent actions and cascades. */
export function publishWorkerThreadLifecycle(core: GatewayCore, thread: ThreadRow) {
  const connection = thread.worker_id ? core.link.connections.get(thread.worker_id) : undefined;

  if (!connection?.isOpen || !connection.hello.capabilities.includes("thread_lifecycle_v1")) return;
  const closed = Boolean(thread.archived_at || thread.deleted_at);

  // Even a repeated state invalidates a snapshot: a rapid reopen/close can end at the cached state.
  connection.threadLifecycleRevision++;

  if (connection.threadLifecycle.get(thread.id) === closed) return;
  connection.send({
    case: "threadLifecycle",
    value: { closedThreadIds: closed ? [thread.id] : [], openedThreadIds: closed ? [] : [thread.id] },
  });
  connection.threadLifecycle.set(thread.id, closed);
}
