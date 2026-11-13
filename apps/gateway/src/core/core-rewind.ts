import { create } from "@bufbuild/protobuf";
import { RewindThreadSchema, ui } from "@canopy/contracts";
import { THREAD_REWIND_CAPABILITY } from "@canopy/domain/release/protocol";
import { Effect } from "effect";
import { coreState, InvalidError, UnavailableError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreBroadcastThread, coreRun } from "./core-broadcast.ts";
import { coreDeliver } from "./core-commands.ts";
import { rewindCommand, rewindResponse } from "../store/rewinds.ts";

async function rewindConnection(core: GatewayCore, threadId: string) {
  const thread = await core.getThread(threadId);
  const connection = core.link.connections.get(thread.workerId);

  if (!connection?.isOpen) throw new UnavailableError("Connect this thread's worker before editing.");

  if (!connection.hello.capabilities.includes(THREAD_REWIND_CAPABILITY))
    throw new InvalidError("Update this thread's worker to use Edit from here.");

  return connection;
}

export interface CoreRewindMethods {
  prepareThreadRewind(request: ui.ThreadRewindRequest): Promise<ui.ThreadRewindPreview>;
  rewindThread(request: ui.ThreadRewindRequest): Promise<ui.ThreadRewindResponse>;
  restoreThreadRewind(request: ui.RestoreThreadRewindRequest): Promise<ui.ThreadRewindResponse>;
  getThreadRewind(request: ui.RestoreThreadRewindRequest): Promise<ui.ThreadRewindResponse>;
}

export const coreRewindMethods: CoreRewindMethods = {
  async getThreadRewind(this: GatewayCore, request) {
    return rewindResponse(
      await coreRun(this, (store) =>
        store.rewindOperation(this[coreState].options.userId, request.threadId, request.rewindId),
      ),
    );
  },
  async prepareThreadRewind(this: GatewayCore, request) {
    const connection = await rewindConnection(this, request.threadId);

    const point = await coreRun(this, (store) =>
      store.prepareRewind(this[coreState].options.userId, request.threadId, request.turnId),
    );

    const spec = await coreRun(this, (store) => store.thread(request.threadId).pipe(Effect.map(store.threadSpec)));

    const files =
      point.thread.provider === "claude"
        ? await connection.sendCommand(
            {
              case: "rewindThread",
              value: create(RewindThreadSchema, {
                ...rewindCommand(point, spec),
                preview: true,
              }),
            },
            30_000,
          )
        : undefined;

    return create(ui.ThreadRewindPreviewSchema, {
      messages: point.suffix.filter((turn) => turn.trigger === "user" && !turn.withdrawn).length,
      running: point.running,
      backgroundTasks: point.tasks,
      filesAvailable: Boolean(files?.ok && files.rewind?.filesAvailable),
      files: files?.rewind?.files ?? [],
      filesDetail:
        files?.rewind?.filesDetail ||
        (point.thread.provider === "claude"
          ? "Checkpoints cover the agent's file edits, excluding shell commands and subagents. Older messages may have no checkpoint."
          : "Files stay as they are."),
    });
  },
  async rewindThread(this: GatewayCore, request) {
    await rewindConnection(this, request.threadId);
    const started = await coreRun(this, (store) => store.beginRewind(this[coreState].options.userId, request));
    await coreBroadcastThread(this, request.threadId);

    if (started.command) await coreDeliver(this, started.worker, started.command);

    return rewindResponse(
      await coreRun(this, (store) =>
        store.rewindOperation(this[coreState].options.userId, request.threadId, started.operation.id),
      ),
    );
  },
  async restoreThreadRewind(this: GatewayCore, request) {
    await rewindConnection(this, request.threadId);

    const started = await coreRun(this, (store) =>
      store.beginRestoreRewind(this[coreState].options.userId, request.threadId, request.rewindId),
    );

    await coreBroadcastThread(this, request.threadId);

    if (started.command) await coreDeliver(this, started.worker, started.command);

    return rewindResponse(
      await coreRun(this, (store) =>
        store.rewindOperation(this[coreState].options.userId, request.threadId, request.rewindId),
      ),
    );
  },
};
