import { SUPERSEDED, TriggerSuperseded } from "../bots/trigger-current.ts";
import { create, fromJson } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { CommandSchema, CommandResultSchema, TurnOutcome, type CommandResult } from "@canopy/contracts";
import { classifyFailure, ProviderFailure } from "@canopy/domain";
import { botImageInput } from "./bot-images.ts";
import { withSlackBotInput } from "./bot-slack-input.ts";
import { BotStore } from "../bots/store.ts";
import type { HarnessTurnRow } from "../bots/store-harness.ts";
import type { BotTurn, ModelInput, ModelReply } from "../bots/types.ts";
import { coreState } from "./core-context.ts";
import { coreWorkers } from "./core-providers.ts";
import { coreDeliver, coreDispatch } from "./core-commands.ts";
import { BOT_WORKER_OUTDATED, BOT_WORKER_REMOVED } from "../bots/store-harness.ts";
import { coreRun } from "./core-broadcast.ts";
import type { GatewayCore } from "./core.ts";
import { workerThreadSnapshot } from "./worker-thread-lifecycle.ts";
import { SERVICE_TIERS_UNSUPPORTED, supportsServiceTier } from "./service-tier-compatibility.ts";

const REMOVED_MESSAGE = "This bot's worker was removed. Pick another worker in Runs on.";

/** How often a turn waiting for its worker checks that the worker still exists. */
const REMOVED_CHECK_MS = 5000;

const configurationKey = (
  configuration: ModelInput["configuration"],
  conversation?: { instructions: string; delivery: "reply" | "notify" },
  slackContextKey?: string,
) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        name: configuration.name,
        instructions: configuration.instructions,
        approvalPolicy: configuration.approvalPolicy,
        webAccess: configuration.webAccess ?? true,
        files: configuration.files ?? true,
        slackContextKey: slackContextKey || undefined,
        conversation: conversation && { instructions: conversation.instructions, delivery: conversation.delivery },
      }),
    )
    .digest("hex");

const harnessTools = (tools: ModelInput["tools"]) =>
  tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchemaJson: JSON.stringify(t.parameters),
  }));

export async function workerJournalWelcome(core: GatewayCore, workerId: string, journalId: string) {
  core[coreState].journalIds.set(workerId, journalId);
  const persisted = journalId ? await coreRun(core, (s) => s.journalCursors(workerId, journalId)) : [];
  const botCursors = journalId ? await core.bots.run((s) => s.harnessCursors(workerId, journalId)) : [];

  return {
    heartbeatIntervalSeconds: 15,
    persisted: [...persisted, ...botCursors],
    isolatedEventIngest: true,
    threadLifecycle: await workerThreadSnapshot(core, workerId),
  };
}

async function botWorker(core: GatewayCore, input: ModelInput, turn: BotTurn, workerId: string): Promise<string> {
  let waited = false;

  while (!workerId) {
    input.signal.throwIfAborted();
    const workers = await coreWorkers(core);

    const candidates = workers.filter(
      (w) =>
        w.online &&
        core.link.connections.get(w.id)?.hello.capabilities.includes("bot_harness_v1") &&
        supportsServiceTier(
          core.link.connections.get(w.id)?.hello.capabilities ?? [],
          input.configuration.serviceTier,
        ) &&
        w.providerInstances.some(
          (i) =>
            i.harness === input.configuration.provider &&
            i.id === input.configuration.providerInstance &&
            i.enabled &&
            i.available,
        ),
    );

    if (core.role === "desktop")
      candidates.sort(
        (a, b) =>
          Number(core.link.connections.get(b.id)?.hello.environmentKind === "desktop") -
          Number(core.link.connections.get(a.id)?.hello.environmentKind === "desktop"),
      );
    workerId = candidates[0]?.id || "";

    if (!workerId) {
      core.bots.waiting(turn.id, true);

      if (!waited) {
        await core.bots.run((s) => s.status(turn, "Waiting for a worker", "Waiting for a worker"));
        waited = true;
      }

      await Bun.sleep(500);
    }
  }

  if (waited) await core.bots.run((s) => s.status(turn, "Typing…", "Typing…"));

  return workerId;
}

async function waitForBotInterrupt(core: GatewayCore, input: ModelInput, workerId: string, botId: string) {
  let checkedAt = Date.now();

  // Across gateways, worker ACK means the previous harness has closed before the next one starts.
  while (await core.bots.run((s) => s.harnessInterruptPending(workerId, botId))) {
    input.signal.throwIfAborted();

    // A removed worker never acknowledges the interrupt.
    if (Date.now() - checkedAt >= REMOVED_CHECK_MS) {
      checkedAt = Date.now();

      if ((await core.bots.run((s) => s.workerBotLink(workerId))) === "removed")
        throw new ProviderFailure("configuration", REMOVED_MESSAGE, "platform");
    }

    await Bun.sleep(100);
  }
}

function harnessReply(job: HarnessTurnRow): ModelReply {
  if (job.error_code === BOT_WORKER_REMOVED) throw new ProviderFailure("configuration", REMOVED_MESSAGE, "platform");

  if (job.outcome !== TurnOutcome.COMPLETED)
    throw new ProviderFailure(
      classifyFailure(job.reason, job.error_class || job.error_code || "HARNESS_ERROR"),
      "Bot harness could not finish this turn",
      "harness",
    );

  return { text: job.text, calls: [] };
}

/** Assemble the turn's files and require the worker capability before persisting its command. */
async function botTurnInput(core: GatewayCore, input: ModelInput, workerId: string, turn: BotTurn) {
  const connection = core.link.connections.get(workerId);

  if (connection?.isOpen && !supportsServiceTier(connection.hello.capabilities, input.configuration.serviceTier))
    throw new ProviderFailure("configuration", SERVICE_TIERS_UNSUPPORTED, "platform");

  if (connection?.isOpen && !connection.hello.capabilities.includes("bot_web_v1"))
    throw new ProviderFailure(
      "configuration",
      "Update this worker to use bot web settings, or choose another worker.",
      "platform",
    );

  if (connection?.isOpen && !connection.hello.capabilities.includes("bot_workspace_v1"))
    throw new ProviderFailure(
      "configuration",
      "Update this worker to use bot files, or choose another worker.",
      "platform",
    );

  const messages = await withSlackBotInput(core, input, workerId, turn);
  const images = await botImageInput(core, turn.bot_id, workerId, messages);

  if (
    (images.attachments.length || images.historyAttachments.length) &&
    connection?.isOpen &&
    !connection.hello.capabilities.includes(
      [...images.attachments, ...images.historyAttachments].some((a) => a.kind !== "image")
        ? "bot_files_v1"
        : "bot_images_v1",
    )
  )
    throw new ProviderFailure(
      "configuration",
      "Update this worker to receive files, or choose another worker.",
      "platform",
    );

  return {
    images,
    sourceAttachments: turn.conversation_id
      ? messages.findLast((message) => message.role === "user")?.attachments
      : undefined,
  };
}

async function assertBotProvider(core: GatewayCore, input: ModelInput, workerId: string) {
  const worker = (await coreWorkers(core)).find((w) => w.id === workerId);

  if (
    !worker?.providerInstances.some(
      (i) => i.harness === input.configuration.provider && i.id === input.configuration.providerInstance && i.enabled,
    )
  )
    throw new ProviderFailure(
      "configuration",
      "The bot's provider instance is not enabled on its pinned worker. Enable it in provider settings or pick another worker in Runs on.",
      "platform",
    );
}

/**
 * A trigger run's command is written only while its worker holds a bot link (on any gateway), so the events it
 * carries are current when it is sent.
 */
async function triggerWorkerOnline(core: GatewayCore, input: ModelInput, workerId: string, turn: BotTurn) {
  if (!turn.client_request_id.startsWith("trigger:")) return;
  let waited = false;

  for (;;) {
    input.signal.throwIfAborted();
    const link = await core.bots.run((s) => s.workerBotLink(workerId));

    if (link === "present") break;

    if (link === "outdated")
      throw new ProviderFailure("configuration", "Update this worker to run bots, or pick another worker.", "platform");

    if (link === "removed") throw new ProviderFailure("configuration", REMOVED_MESSAGE, "platform");

    if (!waited) {
      const name = (await coreWorkers(core)).find((w) => w.id === workerId)?.name || "worker";
      core.bots.waiting(turn.id, true);
      await core.bots.run((s) => s.status(turn, `Waiting for ${name}`, "Waiting for a worker"));
      waited = true;
    }

    await Bun.sleep(500);
  }

  if (waited) {
    core.bots.waiting(turn.id, false);
    await core.bots.run((s) => s.status(turn, "Typing…", "Typing…"));
  }
}

/** The worker's connection, when this gateway holds it, can run this turn. */
function assertConnection(core: GatewayCore, input: ModelInput, turn: BotTurn, workerId: string, started = false) {
  const connection = core.link.connections.get(workerId);

  if (!connection?.isOpen) return;
  const capabilities = connection.hello.capabilities;
  const attachments = input.messages.findLast((m) => m.role === "user")?.attachments ?? [];

  // Checked before the command is written; a command already handed over recovers through its worker.
  if (!started && (turn.conversation_id || input.isolatedInput) && !capabilities.includes("bot_conversations_v1"))
    throw new ProviderFailure(
      "configuration",
      "Update this worker to receive messages from isolated conversations.",
      "platform",
    );

  if (!capabilities.includes("bot_harness_v1"))
    throw new ProviderFailure("configuration", "Update this worker to run bots, or pick another worker.", "platform");

  if (
    attachments.length > 0 &&
    !capabilities.includes(attachments.some((a) => a.kind !== "image") ? "bot_files_v1" : "bot_images_v1")
  )
    throw new ProviderFailure(
      "configuration",
      "Update this worker to receive files, or choose another worker.",
      "platform",
    );
}

/** A trigger run still has events to report: "same", or the run is superseded. */
async function triggerState(core: GatewayCore, turn: BotTurn) {
  const state = await core.bots.run((s) => s.recheckTrigger(core[coreState].options.userId, turn, core.bots.now()));

  if (state !== "same") throw new TriggerSuperseded(state);
}

/**
 * Before the first command: the previous harness of the bot closed, a trigger run's worker is online, the worker
 * can run the turn, its provider is allowed, and a trigger run still has events to report.
 */
async function readyToDispatch(core: GatewayCore, input: ModelInput, workerId: string, turn: BotTurn) {
  await waitForBotInterrupt(core, input, workerId, turn.bot_id);
  await triggerWorkerOnline(core, input, workerId, turn);
  assertConnection(core, input, turn, workerId);
  await assertBotProvider(core, input, workerId);
  await triggerState(core, turn);
}

/** Why a bot turn's command never ran on its worker; a trigger command refused unsent starts its run again. */
async function commandFailure(core: GatewayCore, turn: BotTurn, result: CommandResult) {
  if (result.errorCode === SUPERSEDED) {
    await triggerState(core, turn);

    return new TriggerSuperseded("changed");
  }

  if (result.errorCode === "SERVICE_TIERS_UNSUPPORTED")
    return new ProviderFailure("configuration", SERVICE_TIERS_UNSUPPORTED, "platform");

  if (result.errorCode === BOT_WORKER_OUTDATED)
    return new ProviderFailure("configuration", result.errorMessage, "platform");

  if (result.errorCode === BOT_WORKER_REMOVED) return new ProviderFailure("configuration", REMOVED_MESSAGE, "platform");

  return new ProviderFailure(
    classifyFailure(result.errorMessage, result.errorCode || "HARNESS_ERROR"),
    "Bot worker could not start this turn",
    "harness",
  );
}

/** While a turn waits for its worker, a worker archived or revoked meanwhile ends the turn (checked every 5 s). */
async function endIfWorkerRemoved(core: GatewayCore, turn: BotTurn, workerId: string, checkedAt: number) {
  if (Date.now() - checkedAt < REMOVED_CHECK_MS) return checkedAt;
  await core.bots.run((s) => s.settleRemovedWorker(turn.id, workerId));

  return Date.now();
}

/** A model call attaches to a durable worker command, including after a gateway restart. */
export async function runBotHarness(core: GatewayCore, input: ModelInput): Promise<ModelReply> {
  const turn = input.turn;

  if (!turn) throw new Error("Bot turn is required");
  const run: GatewayCore["bots"]["run"] = (use) => core[coreState].options.runtime.runPromise(BotStore.use(use));
  let job = await run((s) => s.harnessTurn(turn.id));
  const workerId = await botWorker(core, input, turn, job?.worker_id || input.configuration.workerId);
  core.bots.waiting(turn.id, false);

  if (!job) {
    await readyToDispatch(core, input, workerId, turn);
    await run((s) => s.assignWorker(core[coreState].options.userId, turn.bot_id, workerId));
    const { images, sourceAttachments } = await botTurnInput(core, input, workerId, turn);
    const conversation = await run((s) => s.conversationContext(turn));

    const memory =
      input.slackContextKey === turn.id
        ? (await run((s) => s.slackTurnContext(core[coreState].options.userId, turn))).background
        : (input.memoryContext ?? "");

    const command = await run((s) =>
      s.harnessCommand(
        turn,
        workerId,
        create(CommandSchema, {
          // A trigger run restarted before its first send gets a new command; the refused one is retired.
          commandId: turn.client_request_id.startsWith("trigger:") ? Bun.randomUUIDv7() : turn.id,
          kind: {
            case: "runBotTurn",
            value: {
              botId: turn.bot_id,
              turnId: turn.id,
              provider: input.configuration.provider,
              profileId: input.configuration.providerInstance,
              model: input.configuration.model,
              effort: input.configuration.effort,
              serviceTier: input.configuration.serviceTier,
              instructions: input.instructions,
              // Past channel excerpts are never replayed from a native session after a source changes.
              configurationKey: configurationKey(input.configuration, conversation, input.slackContextKey),
              memoryContext: memory,
              // Each relay gets an isolated provider home and workspace, including on older conversation-aware workers.
              conversationId: input.isolatedInput ? turn.id : (turn.conversation_id ?? ""),
              webAccess: !turn.handoff_configuration && !turn.reaction_input && (input.configuration.webAccess ?? true),
              files: !turn.handoff_configuration && !turn.reaction_input && (input.configuration.files ?? true),
              ...images,
              tools: harnessTools(input.tools),
            },
          },
        }),
        sourceAttachments,
      ),
    );

    void coreDeliver(core, workerId, command);
  }

  let lastStatus = "";
  let removedAt = 0;

  try {
    for (;;) {
      input.signal.throwIfAborted();
      job = await run((s) => s.harnessTurn(turn.id));

      if (job?.outcome !== null && job?.outcome !== undefined) return harnessReply(job);

      const failure = await run((s) => s.harnessCommandFailure(turn.id));

      if (failure) {
        throw await commandFailure(core, turn, fromJson(CommandResultSchema, failure));
      }

      assertConnection(core, input, turn, workerId, true);
      const connection = core.link.connections.get(workerId);

      const status = connection?.isOpen
        ? ""
        : `Waiting for ${(await coreWorkers(core)).find((w) => w.id === workerId)?.name || "worker"}`;

      if (status !== lastStatus) {
        core.bots.waiting(turn.id, Boolean(status));
        await run((s) => s.status(turn, status || "Typing…", status ? "Waiting for a worker" : "Typing…"));
        lastStatus = status;
      }

      if (status) removedAt = await endIfWorkerRemoved(core, turn, workerId, removedAt);
      await Bun.sleep(250);
    }
  } finally {
    job = await run((s) => s.harnessTurn(turn.id));

    if (input.signal.aborted && !core.bots.stopping && job?.outcome !== TurnOutcome.INTERRUPTED)
      await coreDispatch(
        core,
        workerId,
        { kind: { case: "interruptBotTurn", value: { threadId: turn.bot_id, turnId: turn.id } } },
        { ttlSeconds: 86400 },
      );
  }
}
