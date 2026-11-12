import { create } from "@bufbuild/protobuf";
import { computerLink as link, ui } from "@canopy/contracts";
import type { LinkedComputers } from "../../../apps/gateway/src/computers/runtime.ts";
import { linkedMessage } from "../../../apps/gateway/src/computers/remote.ts";
import { eventually } from "./gateway.ts";

export async function mirrorCheckpoint(computer: LinkedComputers, home: string, thread: string) {
  const cursor = await eventually(
    async () => (await computer.ranges.cursors(home)).find((checkpoint) => checkpoint.threadId === thread),
    Boolean,
    10000,
  );

  if (!cursor) throw new Error("The thread's mirror checkpoint was not saved");

  return cursor;
}

/** Reconnect to the former home with a saved checkpoint, after the thread has moved away. */
export async function removedFromOldHome(computer: LinkedComputers, home: string, cursor: ui.ThreadSyncCursor) {
  const controller = new AbortController();

  try {
    for await (const message of computer.remote(
      home,
      link.ThreadMirrorService.method.watchThreadMirror,
      create(link.MirrorRequestSchema, { ranges: true, threadCursors: [cursor] }),
      AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    )) {
      if (linkedMessage(link.MirrorUpdateSchema, message).removedThreadId === cursor.threadId) return;
    }

    throw new Error("The old home did not remove the moved thread from its mirror");
  } finally {
    controller.abort();
  }
}
