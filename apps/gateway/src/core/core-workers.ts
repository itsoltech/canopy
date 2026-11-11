import { create } from "@bufbuild/protobuf";
import { ui, type ThreadEvent } from "@canopy/contracts";
import { type WorkerConnection } from "../worker-link/index.ts";
import { Ingest } from "../store/index.ts";
import { coreRedeliver } from "./core-commands.ts";
import { coreState, describeError, SETTLE_TURN_ENDED, steerOf, WORKER_RESTARTED } from "./core-context.ts";
import { coreEndLostTurns, coreSettle } from "./core-work-loop.ts";
import type { GatewayCore } from "./core.ts";
import { coreReceiveBlob, coreSendBlob } from "./core-attachments.ts";
import { corePublishInteraction, coreSendAnswer } from "./core-interactions.ts";
import { corePublishSteer, coreSteers } from "./core-messages.ts";
import { coreSaveModels } from "./core-models.ts";
import { coreBroadcastThread, coreBroadcastTurn, coreBroadcastWorkers, coreLog, coreRun } from "./core-broadcast.ts";
import { coreBroadcastGoal } from "./core-goals.ts";
import { offerWorkerRoutes } from "../network/workers.ts";
import { coreGitHeads } from "../worktrees/heads.ts";
import { coreNameBranchAfterTurn } from "../worktrees/branch-naming.ts";
import { createWorkerLink } from "../worker-link/index.ts";
import { workerJournalWelcome } from "./bot-harness.ts";
import type { IngestObservation } from "../diagnostics/ingest.ts";

export function createCoreWorkerLink(core: GatewayCore) {
  return createWorkerLink({
    onMessage: (connection, message) => core.diagnostics.workerMessage(connection, message),
    observeCommand: (kind) => core.diagnostics.command(kind),
    diagnosticsEnabled: () => core.diagnostics.collector.enabled,
    workerDiagnosticsEnabled: () => core.diagnostics.options.workerDiagnosticsEnabled ?? true,
    authenticate: (credential) => coreRun(core, (s) => s.authenticateWorker(credential)),
    welcome: (workerId, hello) => workerJournalWelcome(core, workerId, hello.journalId),
    config: async (workerId) => (await coreRun(core, (s) => s.workerConfig(workerId))) ?? undefined,
    onConnected: (connection) =>
      coreServe(core, connection).catch((cause: unknown) => {
        coreLog(
          core,
          `worker ${connection.workerId} session failed: ${cause instanceof Error ? cause.message : "initialization failed"}`,
        );
        connection.close();
      }),
  });
}

// ------------------------------------------------------------------ workers

export async function coreServe(hostContext: GatewayCore, connection: WorkerConnection): Promise<void> {
  const { workerId } = connection;
  hostContext.accounts.connected(connection);
  await coreRun(hostContext, (s) =>
    s.workerConnected(workerId, hostContext[coreState].options.instanceId, connection.hello),
  );
  coreLog(hostContext, `worker ${workerId} connected`);
  offerWorkerRoutes(hostContext, connection);
  await hostContext.environment
    .connected(workerId, connection.hello)
    .catch((cause: unknown) =>
      coreLog(hostContext, `environment of worker ${workerId} not synced: ${describeError(cause)}`),
    );
  await coreBroadcastWorkers(hostContext);
  void hostContext.worktreeCleanup.tick(workerId);
  // A paused import continues on this worker (docs/import.md).
  void hostContext.imports.runner.tick(workerId).catch(() => undefined);
  await hostContext.secrets.sync(workerId, true);
  // The outbox is read first: the turns started below (queued behind a lost one) are delivered once.
  await coreRedeliver(hostContext, workerId).catch((cause: unknown) =>
    coreLog(hostContext, `outbox of worker ${workerId} not redelivered: ${describeError(cause)}`),
  );

  // Turns it does not run (e.g. its process restarted) end here; the list is complete only with this capability.
  if (connection.hello.capabilities.includes("running_turns")) {
    await coreEndLostTurns(hostContext, {
      workerId,
      reason: WORKER_RESTARTED,
      keep: connection.hello.runningTurns,
    }).catch((cause: unknown) =>
      coreLog(hostContext, `lost turns of worker ${workerId} not ended: ${describeError(cause)}`),
    );
  }

  try {
    for await (const message of connection.messages) {
      switch (message.payload.case) {
        case "networkRouteStatus":
          connection.networkRouteStatus = message.payload.value;
          await coreBroadcastWorkers(hostContext);
          break;
        case "agentEnvironment":
          await hostContext.environment.report(workerId, message.payload.value);
          break;
        case "gitHeads":
          await coreGitHeads(hostContext, workerId, message.payload.value);
          break;
        case "threadSecretReceipt":
          await hostContext.secrets.receipt(workerId, message.payload.value);
          break;
        case "threadEvent":
          await coreIngest(hostContext, connection, [message.payload.value]);
          break;
        case "configApplied": {
          const report = message.payload.value;
          await coreRun(hostContext, (s) => s.configApplied(workerId, report));

          if (report.applied) hostContext.accounts.applied(connection, report.version);
          await coreBroadcastWorkers(hostContext);
          break;
        }

        case "cliTools":
          await hostContext.cli.report(workerId, message.payload.value);
          await hostContext.environment.connected(workerId, connection.hello, message.payload.value);
          break;
        case "cliInstallProgress":
          await hostContext.cli.progress(workerId, message.payload.value);
          break;
        case "modelCatalog": {
          const catalog = message.payload.value;
          await coreSaveModels(hostContext, workerId, catalog.configVersion, catalog.profiles);
          break;
        }

        case "interactionRequest": {
          const request = message.payload.value;
          const thread = await coreRun(hostContext, (s) => s.thread(request.threadId));

          if (thread.worker_id !== workerId) break;
          const interaction = await coreRun(hostContext, (s) => s.recordInteraction(request));
          await corePublishInteraction(hostContext, interaction);
          // Re-sent after a reconnect and already answered: answer again from the database.
          const answered = await coreRun(hostContext, (s) => s.interactionAnswer(interaction.requestId));

          if (answered) coreSendAnswer(hostContext, connection, answered.answer);
          else await hostContext.bus.onInteraction(interaction);
          break;
        }

        case "agentToolCall": {
          const call = message.payload.value;
          // Concurrent: wait_threads may take minutes and must not hold up the stream.
          void (
            call.botId
              ? hostContext.bots.harnessTools.handle(call, workerId)
              : call.cancelled
                ? hostContext.bus.handle(call, workerId)
                : call.connectorAccountId
                  ? hostContext.connectors.handle(call, workerId)
                  : hostContext.bus.handle(call, workerId)
          ).then(
            (result) => {
              try {
                connection.send({ case: "agentToolResult", value: result });
              } catch {
                // link closed: the worker re-sends the call and gets the stored result
              }
            },
            (cause: unknown) => coreLog(hostContext, `agent bus call ${call.toolName} failed: ${describeError(cause)}`),
          );
          break;
        }

        case "heartbeat":
          await coreRun(hostContext, (s) => s.workerSeen(workerId));
          offerWorkerRoutes(hostContext, connection);
          break;
        case "blobChunk":
          // Before the event that points to it (same stream, handled in order).
          await coreReceiveBlob(hostContext, connection, message.payload.value);
          break;
        case "fetchBlob":
          void coreSendBlob(hostContext, connection, message.payload.value);
          break;
        default:
          break;
      }
    }
  } catch (error) {
    coreLog(hostContext, `worker ${workerId} stream failed: ${describeError(error)}`);
  } finally {
    coreLog(hostContext, `worker ${workerId} disconnected`);
    await coreBroadcastWorkers(hostContext).catch(() => {});
  }
}

export async function coreIngest(
  hostContext: GatewayCore,
  connection: WorkerConnection,
  incoming: ThreadEvent[],
): Promise<void> {
  const observation = hostContext.diagnostics.ingest.start(connection, incoming);

  try {
    await ingestReceived(hostContext, connection, incoming, observation);
  } finally {
    observation?.finish();
  }
}

async function ingestReceived(
  hostContext: GatewayCore,
  connection: WorkerConnection,
  incoming: ThreadEvent[],
  observation: IngestObservation | undefined,
): Promise<void> {
  const journalId = hostContext[coreState].journalIds.get(connection.workerId) ?? "";
  const blocked = hostContext[coreState].blocked.get(connection);
  // Later events of a thread that failed would land out of order: skip them (unacked) until the resend.
  const events = blocked ? incoming.filter((e) => !blocked.has(e.threadId)) : incoming;

  const threads = await ingestBotEvents(hostContext, connection, journalId, events, observation);

  if (threads.length === 0) return;
  await hostContext.connectors.enrich(threads);

  const result = await hostContext[coreState].options.runtime.runPromise(
    Ingest.use((i) => i.ingest(connection.workerId, journalId, threads)),
  );

  for (const [threadId, ackSeq] of result.acks) connection.send({ case: "eventAck", value: { threadId, ackSeq } });
  observation?.ack(result.acks, result.stored.length);

  for (const unknown of result.unknownThreads)
    coreLog(hostContext, `events for unknown thread ${unknown} kept on worker ${connection.workerId}`);

  if (result.failedThreads.length > 0) {
    const set = blocked ?? new Set<string>();
    hostContext[coreState].blocked.set(connection, set);

    for (const { threadId, error } of result.failedThreads) {
      coreLog(
        hostContext,
        `events of thread ${threadId} not stored (kept on worker ${connection.workerId}): ${describeError(error)}`,
      );
      set.add(threadId);
    }

    // The worker resends unacked events after reconnecting: ask for that, a little later.
    if (!blocked) {
      setTimeout(() => {
        if (!connection.isOpen) return;

        try {
          connection.send({
            case: "drain",
            value: { reason: "redelivering events that failed to store", reconnectAfterMs: 10_000 },
          });
        } finally {
          connection.close();
        }
      }, 1_000);
    }
  }

  const touched = new Set<string>();
  const goals = new Set<string>();

  for (const stored of result.stored) {
    hostContext.hub.publishThread(
      stored.threadId,
      create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: stored.seq, event: stored.event } } }),
    );
    const body = stored.event.body;

    if (
      body.case === "threadReady" ||
      body.case === "turnStarted" ||
      body.case === "turnFinished" ||
      body.case === "itemCompleted"
    )
      hostContext.githubDetection.request(stored.threadId);

    if (body.case === "shellInputPrepared") {
      for (const turn of await coreRun(hostContext, (s) => s.turnsOf(stored.threadId)))
        if (turn.input.shellInputId === body.value.inputId)
          await coreBroadcastTurn(hostContext, stored.threadId, turn.id);

      for (const steer of await coreSteers(hostContext, (s) => s.ofThread(stored.threadId)))
        if (steer.input.shellInputId === body.value.inputId) await corePublishSteer(hostContext, steer.id);
    }

    if (body.case === "turnStarted" || body.case === "turnFinished")
      await coreBroadcastTurn(
        hostContext,
        stored.threadId,
        stored.event.turnId,
        body.case === "turnStarted" ? "started" : "finished",
      );

    if (
      body.case === "threadReady" ||
      body.case === "turnStarted" ||
      body.case === "turnFinished" ||
      body.case === "activity"
    )
      touched.add(stored.threadId);

    // Thread.goal_status and Thread.background_tasks follow goals and background items.
    if (body.case === "goalState") {
      goals.add(stored.threadId);
      touched.add(stored.threadId);

      if (stored.event.turnId) await coreBroadcastTurn(hostContext, stored.threadId, stored.event.turnId);
    }

    if (
      (body.case === "itemStarted" || body.case === "itemCompleted") &&
      body.value.item?.content.case === "backgroundTask"
    )
      touched.add(stored.threadId);
    // A steer entered its turn (user_message with its id) or never did (steer_dropped: queued by pump).
    const steerId = steerOf(stored.event);

    if (steerId) {
      await corePublishSteer(hostContext, steerId, body.case === "itemCompleted");
      touched.add(stored.threadId);
    }
  }

  for (const threadId of goals) await coreBroadcastGoal(hostContext, threadId);

  // A turn ended: what it left open is closed (the worker's own reconciliation came before its turn_finished).
  for (const threadId of new Set(
    result.stored.filter((s) => s.event.body.case === "turnFinished").map((s) => s.threadId),
  )) {
    await coreSettle(hostContext, threadId, SETTLE_TURN_ENDED, { publishThread: false });
    // A provisional branch name may be named now that the turn says more about the work.
    coreNameBranchAfterTurn(hostContext, threadId);
  }

  for (const threadId of touched) {
    await coreBroadcastThread(hostContext, threadId);
    await hostContext.pump(threadId);
  }

  for (const stored of result.stored) {
    if (stored.event.body.case === "turnFinished") await hostContext.bus.onTurnFinished(stored.event.turnId);
  }

  // A background task ended (its note waits) or a turn started (notes that wait for one can join it).
  const notes = result.stored.filter(
    ({ event: { body } }) =>
      body.case === "turnStarted" ||
      (body.case === "itemCompleted" && body.value.item?.content.case === "backgroundTask"),
  );

  for (const threadId of new Set(notes.map((s) => s.threadId))) await hostContext.backgroundTasks.deliver(threadId);
}

async function ingestBotEvents(
  host: GatewayCore,
  connection: WorkerConnection,
  journalId: string,
  events: ThreadEvent[],
  observation: IngestObservation | undefined,
) {
  const threads: ThreadEvent[] = [];

  for (const event of events) {
    const handled = event.turnId && (await host.bots.run((s) => s.harnessEvent(connection.workerId, journalId, event)));

    if (!handled) threads.push(event);
    else {
      connection.send({ case: "eventAck", value: { threadId: event.threadId, ackSeq: event.journalSeq } });
      // BotStore's boolean includes replayed events; only regular ingest exposes newly stored counts.
      observation?.ack(new Map([[event.threadId, event.journalSeq]]), 0);
    }
  }

  return threads;
}
