import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { CommandSchema, ui, type Command } from "@canopy/contracts";
import { Effect } from "effect";
import { mentionsFromJson } from "./mentions.ts";
import {
  GatewayStore,
  Ingest,
  permissionModeName,
  permissionModeOf,
  QueueStore,
  turnEffort,
  type ThreadRow,
  type TurnRow,
} from "../store/index.ts";
import { coreDeliver } from "./core-commands.ts";
import {
  coreState,
  describeError,
  SETTLE_SWEEP,
  SETTLE_TURN_ENDED,
  SWEEP_INTERVAL_MS,
  SWEEP_STALE_SECONDS,
  TTL,
  violates,
} from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { corePublishInteraction } from "./core-interactions.ts";
import { corePublishSteer, coreQueueSteer, coreSteers } from "./core-messages.ts";
import { coreProfileModels } from "./core-models.ts";
import { storedShellResult } from "../store/shell-input.ts";
import { coreBroadcastThread, coreBroadcastTurn, coreLog, coreRun } from "./core-broadcast.ts";

/** Turns that no longer run on their worker end as interrupted; the threads go on with what is queued. */
export async function coreEndLostTurns(
  hostContext: GatewayCore,
  input: Parameters<GatewayStore["Service"]["endLostTurns"]>[0],
): Promise<void> {
  const { turns, interactions } = await coreRun(hostContext, (s) => s.endLostTurns(input));

  for (const interaction of interactions) {
    await corePublishInteraction(hostContext, interaction);
  }

  for (const { threadId, turnId } of turns) {
    coreLog(hostContext, `turn ${turnId} of thread ${threadId} ended: ${input.reason}`);
    await coreBroadcastTurn(hostContext, threadId, turnId);

    for (const steer of await coreSteers(hostContext, (s) => s.ofThread(threadId)))
      if (steer.turn_id === turnId && steer.status === "dropped") await corePublishSteer(hostContext, steer.id);
  }

  for (const threadId of new Set(turns.map((t) => t.threadId))) {
    await coreSettle(hostContext, threadId, `${SETTLE_TURN_ENDED} (${input.reason})`, { publishThread: false });
    await coreBroadcastThread(hostContext, threadId);
    await hostContext.pump(threadId);
  }

  for (const { turnId } of turns) await hostContext.bus.onTurnFinished(turnId);
}

/**
 * The safety net behind every turn end (Ingest.settle): items a finished turn left open end as interrupted
 * (published like worker events), its pending interactions expire, a thread that only looks busy or broken is
 * idle again and its queue moves on.
 */
export async function coreSettle(
  hostContext: GatewayCore,
  threadId: string,
  reason: string,
  options: { publishThread?: boolean; staleSeconds?: number } = {},
): Promise<boolean> {
  if (!threadId) return false;

  const settled = await hostContext[coreState].options.runtime.runPromise(
    Ingest.use((i) => i.settle(threadId, reason, options)),
  );

  const expired = await coreRun(hostContext, (s) => s.expireEndedInteractions(threadId));

  for (const stored of settled.stored) {
    hostContext.hub.publishThread(
      threadId,
      create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: stored.seq, event: stored.event } } }),
    );
  }

  for (const interaction of expired) {
    await corePublishInteraction(hostContext, interaction);
  }

  const changed = settled.stored.length > 0 || expired.length > 0 || settled.threadChanged;

  if (changed)
    coreLog(
      hostContext,
      `thread ${threadId} settled: ${settled.stored.length} item(s), ${expired.length} interaction(s)${settled.threadChanged ? ", idle again" : ""} (${reason})`,
    );

  if (changed && options.publishThread !== false) {
    await coreBroadcastThread(hostContext, threadId);
    await hostContext.pump(threadId);
  }

  return changed;
}

export async function corePump(hostContext: GatewayCore, threadId: string): Promise<void> {
  if (hostContext[coreState].actions.defer(() => hostContext.pump(threadId))) return;

  await corePumpQueued(hostContext, threadId);
}

/** Shared admission path, also used inside the transaction accepting a user message. */
export async function corePumpQueued(hostContext: GatewayCore, threadId: string): Promise<void> {
  const state = await coreRun(hostContext, (s) => s.thread(threadId, true));

  if (state.deleted_at || state.archived_at) return;

  // Steers that never joined their turn run next (in order, before anything queued after them).
  for (const steerId of await coreSteers(hostContext, (s) => s.dropped(threadId)))
    await coreQueueSteer(hostContext, steerId, "");

  // The user may reorder or edit the queue meanwhile: the head starts only as read, else it is read again.
  for (let attempt = 0; attempt < 5; attempt++) {
    const turn = await coreRun(hostContext, (s) => s.nextTurn(threadId));

    if (!turn) return;
    const thread = await coreRun(hostContext, (s) => s.thread(threadId));

    if (!thread.worker_id) return;

    if (await coreStartTurn(hostContext, thread, turn)) return;
  }

  coreLog(hostContext, `thread ${threadId}: the queue kept changing, its head was not started`);
}

/** StartTurn for the queue's head, only while it still is the head as read (QueueStore.whileHead). */
export async function coreStartTurn(hostContext: GatewayCore, thread: ThreadRow, turn: TurnRow): Promise<boolean> {
  const threadId = thread.id;
  const workerId = thread.worker_id ?? "";
  const spec = await coreRun(hostContext, (s) => Effect.succeed(s.threadSpec(thread)));
  // The message's override, else the thread's default; an effort the model does not take is left out
  // (turnEffort). Recorded on the turn as what it ran with.
  const model = turn.model || thread.settings.model || "";

  const effort = turnEffort(
    (await coreProfileModels(hostContext, { thread })).models,
    model,
    turn.effort || thread.settings.effort || "",
  );

  // The permission mode the same way: the message's override, else the thread's default (always explicit).
  const permissionMode =
    turn.permission_mode || permissionModeName(permissionModeOf(thread.settings.permissionMode)) || "ASK";

  const command: MessageInitShape<typeof CommandSchema> = {
    kind: {
      case: "startTurn",
      value: {
        thread: spec,
        turnId: turn.id,
        input: {
          text: turn.input.text ?? "",
          shellCommand: turn.input.shellCommand,
          shellInputId: turn.input.shellInputId ?? "",
          shellResult: storedShellResult(turn.input.shellResult),
          authorUserId: hostContext[coreState].options.userId,
          mentions: mentionsFromJson(turn.input.delivered),
          attachments: (turn.input.attachments ?? []).map((a) => ({
            attachmentId: a.id,
            sha256: a.sha256,
            sizeBytes: BigInt(a.sizeBytes),
            mimeType: a.mimeType,
            name: a.name,
            path: a.path,
            kind: a.kind,
          })),
        },
        model,
        effort,
        permissionMode: permissionModeOf(permissionMode),
      },
    },
  };

  let stored: Command | undefined;

  try {
    stored = await hostContext[coreState].actions.run(
      QueueStore.use((q) =>
        q.whileHead(
          { threadId, turnId: turn.id, revision: turn.revision ?? 0 },
          GatewayStore.use((s) =>
            Effect.gen(function* () {
              if (
                model !== (turn.model ?? "") ||
                effort !== (turn.effort ?? "") ||
                permissionMode !== (turn.permission_mode ?? "")
              ) {
                yield* s.setTurnSettings(turn.id, { model, effort, permissionMode });
              }

              return yield* s.enqueueCommand({
                workerId,
                command,
                threadId,
                turnId: turn.id,
                ttlSeconds: TTL.startTurn,
              });
            }),
          ),
        ),
      ),
    );
  } catch (error) {
    // Another pass (a finished turn and a new message at once, or another instance) started it first.
    if (violates(error, "worker_commands_one_start")) return true;
    throw error;
  }

  if (!stored) return false;
  await coreBroadcastTurn(hostContext, threadId, turn.id);
  await coreBroadcastThread(hostContext, threadId);
  const commandToDeliver = stored;

  const deliver = () => {
    void coreDeliver(hostContext, workerId, commandToDeliver);
  };

  // Admission waits for the durable outbox and UI update, not a worker acknowledgement.
  if (!hostContext[coreState].actions.defer(deliver)) deliver();

  return true;
}

export interface CoreWorkLoopMethods {
  sweep(): Promise<string[]>;
  startSweep(intervalMs?: number): void;
  stopSweep(): Promise<void>;
  pump(threadId: string): Promise<void>;
}

export const coreWorkLoopMethods: CoreWorkLoopMethods = {
  /**
   * Finds and fixes what no turn end settled (docs/durability.md, "Stany tury i wątku"): open items of finished
   * turns, threads running without a running turn, interrupted or failed threads that can take turns, interactions
   * of finished turns. Idempotent; at gateway start and every few minutes. Returns the threads it changed.
   */
  async sweep(this: GatewayCore): Promise<string[]> {
    await this.bus.deliverAnswers();
    await this.bus.deliverNotifications();

    const threads = await this[coreState].options.runtime.runPromise(
      Ingest.use((i) => i.unsettledThreads(SWEEP_STALE_SECONDS)),
    );

    const changed: string[] = [];

    for (const threadId of threads) {
      try {
        if (await coreSettle(this, threadId, SETTLE_SWEEP, { staleSeconds: SWEEP_STALE_SECONDS }))
          changed.push(threadId);
      } catch (error) {
        coreLog(this, `sweep of thread ${threadId} failed: ${describeError(error)}`);
      }
    }

    return changed;
  },

  /** Sweeps now and then periodically (main.ts); tests call sweep() directly. */
  startSweep(this: GatewayCore, intervalMs = SWEEP_INTERVAL_MS): void {
    const run = () =>
      void this.sweep().catch((cause: unknown) => coreLog(this, `sweep failed: ${describeError(cause)}`));

    run();
    this[coreState].sweepTimer ??= setInterval(run, intervalMs);
    this.cli.start();
    this.environment.sources.start();
    this.worktreeCleanup.start();
    this.imports.runner.start();
  },

  async stopSweep(this: GatewayCore): Promise<void> {
    const sourcesStopped = Promise.all([this.environment.sources.stop(), this.environment.marketplaces.stop()]);
    this.cli.stop();
    this.connectors.stop();
    this.secrets.stop();

    if (this[coreState].sweepTimer) clearInterval(this[coreState].sweepTimer);
    this[coreState].sweepTimer = undefined;
    await Promise.all([sourcesStopped, this.worktreeCleanup.stop(), this.imports.runner.stop()]);
  },

  /** Starts the next queued turn of a thread when it is ready and nothing else runs. */
  async pump(this: GatewayCore, threadId: string): Promise<void> {
    if (this.updates.draining) {
      this[coreState].updateDeferred.add(threadId);

      return;
    }

    this[coreState].pumpAdmissions++;

    try {
      await corePump(this, threadId);
    } finally {
      this[coreState].pumpAdmissions--;
    }
  },
};
