import { create } from "@bufbuild/protobuf";
import { CommandSchema, ui, type Command } from "@canopy/contracts";
import { Effect } from "effect";
import { joinNotes, SPAWN_PERMISSION_MODES } from "@canopy/domain";
import { mentionsFromJson, mentionsToJson } from "./mentions.ts";
import {
  GatewayStore,
  GoalStore,
  Ingest,
  permissionModeName,
  permissionModeOf,
  QueueStore,
  turnEffort,
  serviceTierProblem,
  inheritedServiceTier,
  type ThreadRow,
  type TurnRow,
} from "../store/index.ts";
import { busPermissionMode } from "../store/agent-bus-types.ts";
import { coreBroadcastGoal } from "./core-goals.ts";
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
import {
  sandboxGoalText,
  SANDBOX_GOAL_UNAVAILABLE,
  SANDBOX_MODE_REQUIRED,
  SANDBOX_SHELL_UNAVAILABLE,
} from "./thread-sandbox.ts";
import type { GatewayCore } from "./core.ts";
import { corePublishInteraction } from "./core-interactions.ts";
import { corePublishSteer, coreQueueSteer, coreSteers } from "./core-messages.ts";
import { coreProfileModels } from "./core-models.ts";
import { queueAdmissionState, resumeModuleGoal, pumpResumedThreads } from "./thread-module-runtime.ts";
import { recoverThreadCreation } from "./thread-creation-recovery.ts";
import { cancelStaleOomRecovery } from "../store/worker-oom-recovery.ts";
import { sandboxCommandThread } from "../store/thread-sandbox.ts";
import { storedShellResult } from "../store/shell-input.ts";
import { takeBranchNote } from "../store/thread-branches.ts";
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
    await coreBroadcastTurn(hostContext, threadId, turnId, "finished");

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

  const undelivered = await coreSteers(hostContext, (s) => s.dropped(threadId));
  const changed = settled.stored.length > 0 || expired.length > 0 || settled.threadChanged || undelivered.length > 0;

  if (changed)
    coreLog(
      hostContext,
      `thread ${threadId} settled: ${settled.stored.length} item(s), ${expired.length} interaction(s), ${undelivered.length} undelivered steer(s)${settled.threadChanged ? ", idle again" : ""} (${reason})`,
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

function deferUpdatePump(core: GatewayCore, threadId: string): boolean {
  if (!core.updates.draining) return false;
  core[coreState].updateDeferred.add(threadId);

  return true;
}

/** Shared admission path, also used inside the transaction accepting a user message. */
export async function corePumpQueued(hostContext: GatewayCore, threadId: string): Promise<void> {
  if (hostContext[coreState].options.relocation?.draining || deferUpdatePump(hostContext, threadId)) return;
  const state = await queueAdmissionState(hostContext, threadId);

  if (!state) return;

  if (state.resume_goal) await resumeModuleGoal(hostContext, await coreRun(hostContext, (s) => s.thread(threadId)));

  if (!state.provider_thread_id) {
    await recoverThreadCreation(hostContext, threadId);

    return;
  }

  // Steers that never joined their turn run next (in order, before anything queued after them).
  for (const steerId of await coreSteers(hostContext, (s) => s.dropped(threadId)))
    await coreQueueSteer(hostContext, steerId, "");

  // The user may reorder or edit the queue meanwhile: the head starts only as read, else it is read again.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (hostContext[coreState].options.relocation?.draining || deferUpdatePump(hostContext, threadId)) return;
    const turn = await coreRun(hostContext, (s) => s.nextTurn(threadId));

    if (!turn) return;
    const thread = await coreRun(hostContext, (s) => s.thread(threadId));

    if (!thread.worker_id) return;

    if (await coreStartTurn(hostContext, thread, turn)) return;
  }

  coreLog(hostContext, `thread ${threadId}: the queue kept changing, its head was not started`);
}

function queuedTurnInput(turn: TurnRow, userId: string) {
  return {
    text: turn.input.text ?? "",
    shellCommand: turn.input.shellCommand,
    shellInputId: turn.input.shellInputId ?? "",
    shellResult: storedShellResult(turn.input.shellResult),
    authorUserId: turn.trigger === "recovery" ? "" : userId,
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
  };
}

function sandboxTurnProblem(threadMode: string, turnMode: string, turn: TurnRow) {
  if (threadMode !== "FULL_AUTO" || turnMode !== "FULL_AUTO") return SANDBOX_MODE_REQUIRED;

  if (turn.input.shellCommand !== undefined) return SANDBOX_SHELL_UNAVAILABLE;

  if (turn.trigger === "goal" || sandboxGoalText(turn.input.text ?? "")) return SANDBOX_GOAL_UNAVAILABLE;

  return undefined;
}

function applyBranchNote(threadId: string, turn: TurnRow, command: Command, note: string | undefined) {
  if (!note || command.kind.case !== "startTurn" || !command.kind.value.input) return Effect.void;
  const input = command.kind.value.input;
  const prefix = `${note}\n\n`;
  input.contextNote = joinNotes(note, turn.input.note ?? "");
  input.text = prefix + input.text;

  for (const mention of input.mentions) {
    mention.start += prefix.length;
    mention.end += prefix.length;
  }

  return takeBranchNote(threadId, turn.id, {
    text: input.text,
    note: joinNotes(note, turn.input.note ?? ""),
    branchNote: note,
    message: turn.input.message ?? turn.input.text ?? "",
    delivered: mentionsToJson(input.mentions),
  });
}

/** StartTurn for the queue's head, only while it still is the head as read (QueueStore.whileHead). */
export async function coreStartTurn(hostContext: GatewayCore, thread: ThreadRow, turn: TurnRow): Promise<boolean> {
  const threadId = thread.id;
  const workerId = thread.worker_id ?? "";
  const models = (await coreProfileModels(hostContext, { thread })).models;

  let stored: Command | undefined;
  let rejected = false;
  let rejectedGoal = false;

  try {
    stored = await hostContext[coreState].actions.run(
      QueueStore.use((q) =>
        q.whileHead(
          { ownerUserId: thread.owner_user_id, threadId, turnId: turn.id, revision: turn.revision ?? 0 },
          GatewayStore.use((s) =>
            Effect.gen(function* () {
              // Read context under the admission lock: a branch switch may have completed while this turn queued.
              const current = yield* s.thread(threadId);
              const spec = s.threadSpec(current);
              const recovery = turn.trigger === "recovery";

              if (recovery && turn.resumes_turn_id) {
                rejected = yield* cancelStaleOomRecovery(threadId, turn.resumes_turn_id, turn.id);

                if (rejected) return;
                spec.model = turn.model ?? "";
                spec.serviceTier = turn.service_tier ?? "";
              }

              const model = turn.model || spec.model;

              const effort = recovery
                ? (turn.effort ?? "")
                : turnEffort(models, model, turn.effort || current.settings.effort || "");

              const serviceTier =
                recovery || turn.thread_permission_mode
                  ? (turn.service_tier ?? "")
                  : turn.service_tier ||
                    inheritedServiceTier(
                      models,
                      model,
                      current.settings.model ?? "",
                      current.settings.serviceTier ?? "",
                    );

              const threadPermissionMode = permissionModeName(spec.permissionMode) || "ASK";
              const requestedMode = turn.permission_mode || threadPermissionMode;
              const ceiling = turn.input.permissionCeiling;

              const permissionMode =
                ceiling &&
                SPAWN_PERMISSION_MODES.indexOf(ceiling) <
                  SPAWN_PERMISSION_MODES.indexOf(busPermissionMode(requestedMode))
                  ? ceiling.toUpperCase()
                  : requestedMode;

              const sandboxProblem = spec.sandboxProfile
                ? sandboxTurnProblem(threadPermissionMode, permissionMode, turn)
                : undefined;

              const problem = sandboxProblem ?? serviceTierProblem(models, model, serviceTier);

              if (problem) {
                const code = sandboxProblem ? "SANDBOX_PROFILE_UNAVAILABLE" : "SERVICE_TIER_UNAVAILABLE";
                yield* s.failTurn(turn.id, problem, "platform", code);
                rejectedGoal = Boolean(
                  yield* GoalStore.use((goals) => goals.turnFailed(turn.id, `${code}: ${problem}`)),
                );
                rejected = true;

                return;
              }

              const command = create(CommandSchema, {
                kind: {
                  case: "startTurn",
                  value: {
                    ...sandboxCommandThread(spec),
                    turnId: turn.id,
                    input: queuedTurnInput(turn, hostContext[coreState].options.userId),
                    model,
                    effort,
                    serviceTier,
                    permissionMode: permissionModeOf(permissionMode),
                  },
                },
              });

              yield* applyBranchNote(threadId, turn, command, current.settings.branchNote);

              if (
                model !== (turn.model ?? "") ||
                effort !== (turn.effort ?? "") ||
                serviceTier !== (turn.service_tier ?? "") ||
                permissionMode !== (turn.permission_mode ?? "") ||
                threadPermissionMode !== (turn.thread_permission_mode ?? "")
              ) {
                yield* s.setTurnSettings(turn.id, { model, effort, serviceTier, permissionMode, threadPermissionMode });
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

  if (!stored) {
    if (rejected) await coreBroadcastTurn(hostContext, threadId, turn.id, "finished");

    if (rejectedGoal) await coreBroadcastGoal(hostContext, threadId);

    return false;
  }

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
    await pumpResumedThreads(this);
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
    this.copyJobs.start();
    this.github.device.start();
    this.github.background.start();
    this.checkWatches.start();
    this.githubDetection.start();
    this.proxyAccounts.start();
    this.snoozes.start();
  },

  async stopSweep(this: GatewayCore): Promise<void> {
    await this.githubDetection.stop();
    const sourcesStopped = Promise.all([this.environment.sources.stop(), this.environment.marketplaces.stop()]);
    this.cli.stop();
    this.proxyAccounts.stop();
    this.connectors.stop();
    this.secrets.stop();

    if (this[coreState].sweepTimer) clearInterval(this[coreState].sweepTimer);
    this[coreState].sweepTimer = undefined;
    await Promise.all([
      sourcesStopped,
      this.worktreeCleanup.stop(),
      this.imports.runner.stop(),
      this.copyJobs.stop(),
      this.checkWatches.stop(),
      this.snoozes.stop(),
      this.github.stop(),
    ]);
  },

  /** Starts the next queued turn of a thread when it is ready and nothing else runs. */
  async pump(this: GatewayCore, threadId: string): Promise<void> {
    this[coreState].pumpAdmissions++;

    try {
      await corePump(this, threadId);
    } finally {
      this[coreState].pumpAdmissions--;
    }
  },
};
