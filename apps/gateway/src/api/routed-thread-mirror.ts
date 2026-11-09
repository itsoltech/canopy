import { create, type DescMethod, type Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { splitId, THREAD_MIRROR, THREAD_MIRROR_DELTA } from "@canopy/domain/computers";
import { applyThreadDelta } from "@canopy/domain/thread-mirror";
import { AsyncChannel } from "@canopy/transport";
import { Code, ConnectError } from "@connectrpc/connect";
import { linkedMessage } from "../computers/remote.ts";
import type { LinkedComputers } from "../computers/runtime.ts";
import { threadHistory } from "../core/thread-history.ts";

/** Seed online reads locally; actions always continue to the owner-scoped home handlers. */
export async function* mirrorFirst(
  computers: LinkedComputers,
  nodeId: string,
  method: DescMethod,
  request: Message,
  send: (request: Message) => AsyncIterable<Message>,
): AsyncGenerator<Message, boolean> {
  if (
    !computers.reachable().includes(nodeId) ||
    !computers.capabilities(nodeId).includes(THREAD_MIRROR) ||
    (method.name !== "GetThread" && method.name !== "WatchThread")
  )
    return false;

  const threadId = splitId(
    method.name === "GetThread"
      ? linkedMessage(ui.GetThreadRequestSchema, request).threadId
      : linkedMessage(ui.WatchThreadRequestSchema, request).threadId,
  ).id;

  if (method.name === "GetThread") {
    const thread = await computers.mirror.thread(nodeId, threadId);

    if (!thread) return false;
    yield create(ui.GetThreadResponseSchema, { thread });

    return true;
  }

  const input = linkedMessage(ui.WatchThreadRequestSchema, request);

  // A UI with its own base resumes directly at the home; a cold UI still gets the mirror first.
  if (input.incremental && input.cursor && !input.pageSize) return false;
  const held = await computers.mirror.read(nodeId, threadId);
  const snapshot = held?.snapshot;

  if (!held || !snapshot?.thread) return false;

  // Phone history windows must be readable before a live-looking dead socket times out.
  // The home then sends a fresh window; its cursor cannot be resumed from the mirror's local seed.
  if (input.pageSize) {
    // An older/stale mirror cannot extend a window from a different authoritative history.
    if (input.historyVersion && input.historyVersion !== snapshot.historyVersion) return false;
    yield mirroredPage(snapshot, input, `offline:${held.cursor}`);

    yield* send(create(ui.WatchThreadRequestSchema, { ...input, cursor: "", mirrorCursor: "" }));

    return true;
  }

  yield create(ui.ThreadUpdateSchema, { syncing: true, change: { case: "snapshot", value: snapshot } });

  const outbound = create(ui.WatchThreadRequestSchema, {
    incremental: input.incremental,
    threadId: linkedMessage(ui.WatchThreadRequestSchema, request).threadId,
    mirrorCursor:
      computers.hello().capabilities.includes(THREAD_MIRROR_DELTA) &&
      computers.capabilities(nodeId).includes(THREAD_MIRROR_DELTA)
        ? held.cursor
        : "",
  });

  let initial = true;

  for await (const message of send(outbound)) {
    const update = linkedMessage(ui.ThreadUpdateSchema, message);

    if (update.change.case === "delta" && initial) {
      if (update.change.value.baseCursor !== held.cursor)
        throw new ConnectError("Thread mirror cursor mismatch", Code.DataLoss);
      yield create(ui.ThreadUpdateSchema, {
        change: { case: "snapshot", value: applyThreadDelta(snapshot, update.change.value) },
      });
    } else yield update;

    if (update.change.case) initial = false;
  }

  return true;
}

function mirroredPage(snapshot: ui.ThreadSnapshot, input: ui.WatchThreadRequest, cursor: string) {
  const value = threadHistory(create(ui.ThreadSnapshotSchema, { ...snapshot, cursor }), input);

  const unchanged =
    !!cursor &&
    input.incremental &&
    input.cursor === cursor &&
    !input.beforeTurnId &&
    !input.targetItemId &&
    !value.historyReset;

  return create(ui.ThreadUpdateSchema, {
    syncing: true,
    change: unchanged
      ? { case: "delta", value: { baseCursor: cursor, snapshot: { ...value, turns: [], items: [], notices: [] } } }
      : { case: "snapshot", value },
  });
}

/** Offline watches stay readable until presence changes and the client reconnects. */
export async function* offlineThread(
  computers: LinkedComputers,
  nodeId: string,
  method: DescMethod,
  request: Message,
  signal: AbortSignal,
): AsyncGenerator<Message, boolean> {
  if (method.name !== "GetThread" && method.name !== "WatchThread") return false;

  const threadId = splitId(
    method.name === "GetThread"
      ? linkedMessage(ui.GetThreadRequestSchema, request).threadId
      : linkedMessage(ui.WatchThreadRequestSchema, request).threadId,
  ).id;

  const held = await computers.mirror.read(nodeId, threadId);
  const snapshot = held?.snapshot;

  if (!snapshot?.thread)
    throw new ConnectError("This thread has not been synced yet. Connect its computer to read it.", Code.Unavailable);

  if (method.name === "GetThread") yield create(ui.GetThreadResponseSchema, { thread: snapshot.thread });
  else {
    const changes = new AsyncChannel<void>();

    const unsubscribe = computers.subscribe((c) => {
      if (c.nodeId === nodeId) changes.close();
    });

    const abort = () => changes.close();
    signal.addEventListener("abort", abort, { once: true });

    try {
      const input = linkedMessage(ui.WatchThreadRequestSchema, request);
      const cursor = input.pageSize && held ? `offline:${held.cursor}` : snapshot.cursor;
      yield mirroredPage(snapshot, input, cursor);

      if (!signal.aborted && !computers.reachable().includes(nodeId))
        for await (const _ of changes) {
          /* closed by a change */
        }
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", abort);
    }
  }

  return true;
}
