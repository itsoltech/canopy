import { cancelStaleGenerations } from "./generation-cancellation.ts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { lockedOwnerModule, moduleDisabledMessage } from "../store/module-access.ts";
import { create } from "@bufbuild/protobuf";
import { ui, type InteractionRequest, type ThreadEvent } from "@canopy/contracts";
import { PROJECT_SECRET_LEASES } from "@canopy/domain";
import { isTaskListItem } from "@canopy/domain/task-list";
import { type WorkerConnection } from "../worker-link/index.ts";
import { Ingest } from "../store/index.ts";
import { coreRedeliver } from "./core-commands.ts";
import { coreState, describeError, SETTLE_TURN_ENDED, steerOf } from "./core-context.ts";
import { WORKER_RESTARTED } from "../store/worker-oom-recovery.ts";
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
import type { IngestFallback } from "../store/ingest-outcomes.ts";
import { sqlErrorCode } from "../store/event-quarantine.ts";
import { WorkerIngestQueue } from "./worker-ingest-queue.ts";
import { syncWorkerThreadLifecycle } from "./worker-thread-lifecycle.ts";
import { coreTurnLogin } from "./turn-logins.ts";
import { offerWorkerStorage, completeWorkerStorage } from "./worker-storage.ts";
import { handleWorkerToolCall } from "./worker-tool-call.ts";
import { expireLocalAutomationLeases, finishLocalAutomation } from "./automation-permissions.ts";
import { allowFullAccessPermission, settleTurnPermissions } from "./live-turn-permissions.ts";
import { permissionsChanged } from "./turn-permission-state.ts";

export function createCoreWorkerLink(core: GatewayCore) {
  return createWorkerLink({
    onMessage: (connection, message) => core.diagnostics.workerMessage(connection, message),
    projectSecretDeliveryValue: (connection, delivery) => core.secrets.projectSecretDeliveryValue(connection, delivery),
    onBlobChunk: (connection, chunk) => coreReceiveBlob(core, connection, chunk),
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

async function workerConnected(hostContext: GatewayCore, connection: WorkerConnection) {
  const { workerId } = connection;
  hostContext.accounts.connected(connection);
  hostContext.feeds.nudge();
  coreLog(hostContext, `worker ${workerId} connected`);
  // Re-read after registration to close the Welcome/config handshake's lifecycle race.
  await syncWorkerThreadLifecycle(hostContext, connection);
  offerWorkerRoutes(hostContext, connection);
  await offerWorkerStorage(hostContext, connection);
  await hostContext.environment
    .connected(workerId, connection.hello)
    .catch((cause: unknown) =>
      coreLog(hostContext, `environment of worker ${workerId} not synced: ${describeError(cause)}`),
    );
  await coreBroadcastWorkers(hostContext);
  void hostContext.worktreeCleanup.tick(workerId);
  // A paused import continues on this worker (docs/import.md).
  void hostContext.imports.runner.tick(workerId).catch(() => undefined);
  // A background copy waiting for this worker continues (docs/workspace-copy.md).
  void hostContext.copyJobs.tick();
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
    }).catch((cause: unknown) => {
      if (connection.hello.capabilities.includes(PROJECT_SECRET_LEASES)) throw cause;
      coreLog(hostContext, `lost turns of worker ${workerId} not ended: ${describeError(cause)}`);
    });
  }

  connection.projectSecretLeasesReady = true;
  await hostContext.secrets.syncProjectLeases(connection);
}

export async function coreServe(hostContext: GatewayCore, connection: WorkerConnection): Promise<void> {
  const { workerId } = connection;
  const ingest = ingestQueue(hostContext, connection);

  const epoch = await coreRun(hostContext, (s) =>
    s.workerConnected(workerId, hostContext[coreState].options.instanceId, connection.hello),
  );

  connection.registrationEpoch = epoch;

  try {
    await workerConnected(hostContext, connection);

    for await (const message of connection.messages) {
      switch (message.payload.case) {
        case "providerUsage":
          await hostContext.usage.report(connection, message.payload.value);
          break;
        case "networkRouteStatus":
          connection.networkRouteStatus = message.payload.value;
          await coreBroadcastWorkers(hostContext, "status", workerId);
          break;
        case "agentEnvironment":
          await hostContext.environment.report(connection, message.payload.value);
          break;
        case "gitHeads":
          await coreGitHeads(hostContext, workerId, message.payload.value);
          break;
        case "threadSecretReceipt":
          await hostContext.secrets.receipt(connection, message.payload.value);
          break;
        case "threadEvent":
          await ingest.enqueue(connection.eventBatch(message.payload.value));
          break;
        case "configApplied": {
          const report = message.payload.value;
          await coreRun(hostContext, (s) => s.configApplied(workerId, report));

          if (report.applied) hostContext.accounts.applied(connection, report.version);
          await coreBroadcastWorkers(hostContext);
          await coreRedeliver(hostContext, workerId);
          break;
        }

        case "cliTools":
          await hostContext.cli.report(connection, message.payload.value);
          await hostContext.environment.connected(workerId, connection.hello, message.payload.value);
          break;
        case "agentToolsReport":
          await hostContext.agentTools.report(workerId, message.payload.value);
          break;
        case "agentToolProgress":
          await hostContext.agentTools.progress(workerId, message.payload.value);
          break;
        case "cliInstallProgress":
          await hostContext.cli.progress(connection, message.payload.value);
          break;
        case "modelCatalog": {
          const catalog = message.payload.value;
          await coreSaveModels(hostContext, workerId, catalog.configVersion, catalog.profiles);
          break;
        }

        case "interactionRequest":
          await workerInteraction(hostContext, connection, message.payload.value);
          break;
        case "agentToolCall":
          void handleWorkerToolCall(hostContext, connection, message.payload.value);
          break;
        case "localAutomationFinished":
          finishLocalAutomation(hostContext, connection, message.payload.value.callId);
          break;

        case "heartbeat":
          expireLocalAutomationLeases(hostContext, connection, Date.now());
          await cancelStaleGenerations(hostContext, [connection]);
          await coreRun(hostContext, (s) => s.workerSeen(workerId, epoch));
          await coreRedeliver(hostContext, workerId);
          await offerWorkerStorage(hostContext, connection);
          offerWorkerRoutes(hostContext, connection);
          break;
        case "threadStorageCleanup":
          completeWorkerStorage(connection, message.payload.value);
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
    await coreRun(hostContext, (s) => s.workerDisconnected(workerId, epoch)).catch(() => {});
    await ingest.finished();
    hostContext.feeds.nudge();
    coreLog(hostContext, `worker ${workerId} disconnected`);
    await coreBroadcastWorkers(hostContext).catch(() => {});
  }
}

async function workerInteraction(core: GatewayCore, connection: WorkerConnection, request: InteractionRequest) {
  const thread = await coreRun(core, (s) => s.thread(request.threadId));

  if (thread.worker_id !== connection.workerId) return;

  const actions = core[coreState].actions;

  const interaction = await actions.transaction(async () => {
    const enabled = await actions.run(
      Effect.flatMap(SqlClient.SqlClient, (sql) => lockedOwnerModule(sql, thread.owner_user_id, "threads")),
    );

    if (!enabled) return;

    return coreRun(core, (s) => s.recordInteraction(request));
  });

  if (!interaction) {
    coreSendAnswer(
      core,
      connection,
      create(ui.AnswerInteractionRequestSchema, {
        requestId: request.requestId,
        cancelled: true,
        message: moduleDisabledMessage("threads"),
      }),
    );

    return;
  }

  await corePublishInteraction(core, interaction);
  await allowFullAccessPermission(core, interaction);

  // Re-sent after a reconnect and already answered: answer again from the database.
  const answered = await coreRun(core, (s) =>
    s.interactionAnswer(interaction.requestId, { threadId: request.threadId, workerId: connection.workerId }),
  );

  if (answered) coreSendAnswer(core, connection, answered.answer);
  else await core.bus.onInteraction(interaction);
}

export async function coreIngest(
  hostContext: GatewayCore,
  connection: WorkerConnection,
  incoming: ThreadEvent[],
  fallback?: IngestFallback,
): Promise<string | undefined> {
  const observation = hostContext.diagnostics.ingest.start(connection, incoming);

  try {
    return await ingestReceived(hostContext, connection, incoming, observation, fallback);
  } catch {
    // Enrichment and bot persistence failures also retain the journal and use the per-thread retry lane.
    for (const threadId of new Set(incoming.map((event) => event.threadId))) {
      coreLog(
        hostContext,
        `worker events not stored: worker ${connection.workerId} thread ${threadId} reason ${fallback ? "quarantine_unavailable" : "retry_pending"}`,
      );
      hostContext.diagnostics.collector.measure(41, 1);
    }

    return "58000";
  } finally {
    observation?.finish();
  }
}

async function ingestReceived(
  hostContext: GatewayCore,
  connection: WorkerConnection,
  incoming: ThreadEvent[],
  observation: IngestObservation | undefined,
  fallback?: IngestFallback,
): Promise<string | undefined> {
  const journalId = connection.hello.journalId;

  const threads = await ingestBotEvents(hostContext, connection, journalId, incoming, observation);

  if (threads.length === 0) return;
  await hostContext.connectors.enrich(threads);

  const result = await hostContext[coreState].options.runtime.runPromise(
    Ingest.use((i) => i.ingest(connection.workerId, journalId, threads, fallback)),
  );

  for (const [threadId, ackSeq] of result.acks) connection.send({ case: "eventAck", value: { threadId, ackSeq } });
  observation?.ack(result.acks, result.stored.length);

  if (result.unknownThreads.length) releaseUnknownEvents(hostContext, connection, threads, result.unknownThreads);

  for (const outcome of result.outcomes) {
    coreLog(
      hostContext,
      `worker events ${outcome.kind}: worker ${connection.workerId} thread ${outcome.threadId} count ${outcome.count} reason ${outcome.reason}`,
    );
    hostContext.diagnostics.collector.measure(outcome.kind === "dropped" ? 42 : 43, outcome.count);
  }

  for (const { threadId } of result.failedThreads) {
    coreLog(
      hostContext,
      `worker events not stored: worker ${connection.workerId} thread ${threadId} reason ${fallback ? "quarantine_unavailable" : "retry_pending"}`,
    );
    hostContext.diagnostics.collector.measure(41, 1);
  }

  const touched = new Set<string>();
  const goals = new Set<string>();

  for (const stored of result.stored) {
    hostContext.hub.publishThread(
      stored.threadId,
      create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: stored.seq, event: stored.event } } }),
    );
    const body = stored.event.body;

    if (body.case === "turnPermissionsChanged") {
      permissionsChanged(hostContext[coreState].options.runtime);
      await coreBroadcastTurn(hostContext, stored.threadId, stored.event.turnId);
      await settleTurnPermissions(hostContext, stored.threadId, stored.event.turnId);
      touched.add(stored.threadId);
    }

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
      body.case === "activity" ||
      (body.case === "usageUpdated" && Boolean(body.value.contextUsage))
    )
      touched.add(stored.threadId);

    // Thread.goal_status follows goals.
    if (body.case === "goalState") {
      goals.add(stored.threadId);
      touched.add(stored.threadId);

      if (stored.event.turnId) await coreBroadcastTurn(hostContext, stored.threadId, stored.event.turnId);
    }

    // Thread.tasks follows checklist items (update_tasks, harness plans and todo lists).
    if (
      (body.case === "itemStarted" || body.case === "itemCompleted") &&
      body.value.item &&
      (body.value.item.content.case === "backgroundTask" || isTaskListItem(body.value.item))
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
    if (stored.event.body.case !== "turnFinished") continue;
    await hostContext.bus.onTurnFinished(stored.event.turnId);
    // Reads the account on the worker again: never holds up ingestion.
    void coreTurnLogin(hostContext, connection.workerId, stored.threadId, stored.event.body.value);
  }

  // A background task ended (its note waits) or a turn started (notes that wait for one can join it).
  const notes = result.stored.filter(
    ({ event: { body } }) =>
      body.case === "turnStarted" ||
      (body.case === "itemCompleted" && body.value.item?.content.case === "backgroundTask"),
  );

  for (const threadId of new Set(notes.map((s) => s.threadId))) await hostContext.backgroundTasks.deliver(threadId);

  // CI check notes waiting for a turn (hop limit, a dispatched start) can join one that started.
  for (const { threadId } of result.stored.filter(({ event: { body } }) => body.case === "turnStarted"))
    await hostContext.checkWatches.deliver(threadId);

  const failure = result.failedThreads[0];

  return failure ? (sqlErrorCode(failure.error) ?? "58000") : undefined;
}

function releaseUnknownEvents(
  hostContext: GatewayCore,
  connection: WorkerConnection,
  events: ThreadEvent[],
  ids: readonly string[],
) {
  const unknown = new Set(ids);

  for (const event of events)
    if (unknown.has(event.threadId)) connection.finishedIngest(event.threadId, event.journalSeq);

  for (const id of unknown)
    coreLog(hostContext, `events for unknown thread ${id} kept on worker ${connection.workerId}`);
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

      if (event.body.case === "turnStarted" || event.body.case === "turnFinished") host.feeds.nudge();
      // BotStore's boolean includes replayed events; only regular ingest exposes newly stored counts.
      observation?.ack(new Map([[event.threadId, event.journalSeq]]), 0);
    }
  }

  return threads;
}

function ingestQueue(host: GatewayCore, connection: WorkerConnection) {
  return new WorkerIngestQueue(connection, (events, fallback) => coreIngest(host, connection, events, fallback));
}
