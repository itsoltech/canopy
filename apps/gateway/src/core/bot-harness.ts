import { create, fromJson } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { CommandSchema, CommandResultSchema, TurnOutcome } from "@canopy/contracts";
import { classifyFailure, ProviderFailure } from "@canopy/domain";
import { botImageInput } from "./bot-images.ts";
import { BotStore } from "../bots/store.ts";
import type { HarnessTurnRow } from "../bots/store-harness.ts";
import type { BotTurn, ModelInput, ModelReply } from "../bots/types.ts";
import { coreState } from "./core-context.ts";
import { coreWorkers } from "./core-providers.ts";
import { coreDeliver, coreDispatch } from "./core-commands.ts";
import { coreRun } from "./core-broadcast.ts";
import type { GatewayCore } from "./core.ts";

const configurationKey = (configuration: ModelInput["configuration"]) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        name: configuration.name,
        instructions: configuration.instructions,
        approvalPolicy: configuration.approvalPolicy,
        webAccess: configuration.webAccess ?? true,
        files: configuration.files ?? true,
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

  return { heartbeatIntervalSeconds: 15, persisted: [...persisted, ...botCursors] };
}

async function botWorker(core: GatewayCore, input: ModelInput, turn: BotTurn, workerId: string): Promise<string> {
  while (!workerId) {
    input.signal.throwIfAborted();
    const workers = await coreWorkers(core);

    const candidates = workers.filter(
      (w) =>
        w.online &&
        core.link.connections.get(w.id)?.hello.capabilities.includes("bot_harness_v1") &&
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
      await core.bots.run((s) => s.status(turn, "Waiting for a worker"));
      await Bun.sleep(500);
    }
  }

  return workerId;
}

async function waitForBotInterrupt(core: GatewayCore, input: ModelInput, workerId: string, botId: string) {
  // Across gateways, worker ACK means the previous harness has closed before the next one starts.
  while (await core.bots.run((s) => s.harnessInterruptPending(workerId, botId))) {
    input.signal.throwIfAborted();
    await Bun.sleep(100);
  }
}

function harnessReply(job: HarnessTurnRow): ModelReply {
  if (job.outcome !== TurnOutcome.COMPLETED)
    throw new ProviderFailure(
      classifyFailure(job.reason, job.error_class || job.error_code || "HARNESS_ERROR"),
      "Bot harness could not finish this turn",
      "harness",
    );

  return { text: job.text, calls: [] };
}

/** Assemble the turn's files and require the worker capability before persisting its command. */
async function botTurnInput(core: GatewayCore, input: ModelInput, workerId: string, botId: string) {
  const images = await botImageInput(core, botId, workerId, input.messages);
  const connection = core.link.connections.get(workerId);

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

  return images;
}

/** A model call attaches to a durable worker command, including after a gateway restart. */
export async function runBotHarness(core: GatewayCore, input: ModelInput): Promise<ModelReply> {
  const turn = input.turn;
  const attachments = input.messages.findLast((m) => m.role === "user")?.attachments ?? [];

  if (!turn) throw new Error("Bot turn is required");
  const run: GatewayCore["bots"]["run"] = (use) => core[coreState].options.runtime.runPromise(BotStore.use(use));
  let job = await run((s) => s.harnessTurn(turn.id));
  const workerId = await botWorker(core, input, turn, job?.worker_id || input.configuration.workerId);
  core.bots.waiting(turn.id, false);

  if (!job) {
    await waitForBotInterrupt(core, input, workerId, turn.bot_id);
    const connection = core.link.connections.get(workerId);

    if (connection?.isOpen && !connection.hello.capabilities.includes("bot_harness_v1"))
      throw new ProviderFailure("configuration", "Update this worker to run bots, or pick another worker.", "platform");
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
    await run((s) => s.assignWorker(core[coreState].options.userId, turn.bot_id, workerId));
    const images = await botTurnInput(core, input, workerId, turn.bot_id);

    const command = await run((s) =>
      s.harnessCommand(
        turn,
        workerId,
        create(CommandSchema, {
          commandId: turn.id,
          kind: {
            case: "runBotTurn",
            value: {
              botId: turn.bot_id,
              turnId: turn.id,
              provider: input.configuration.provider,
              profileId: input.configuration.providerInstance,
              model: input.configuration.model,
              effort: input.configuration.effort,
              instructions: input.instructions,
              configurationKey: configurationKey(input.configuration),
              webAccess: !turn.handoff_configuration && (input.configuration.webAccess ?? true),
              files: !turn.handoff_configuration && (input.configuration.files ?? true),
              ...images,
              tools: harnessTools(input.tools),
            },
          },
        }),
      ),
    );

    void coreDeliver(core, workerId, command);
  }

  let lastStatus = "";

  try {
    for (;;) {
      input.signal.throwIfAborted();
      job = await run((s) => s.harnessTurn(turn.id));

      if (job?.outcome !== null && job?.outcome !== undefined) return harnessReply(job);

      const failure = await run((s) => s.harnessCommandFailure(turn.id));

      if (failure) {
        const result = fromJson(CommandResultSchema, failure);
        throw new ProviderFailure(
          classifyFailure(result.errorMessage, result.errorCode || "HARNESS_ERROR"),
          "Bot worker could not start this turn",
          "harness",
        );
      }

      const connection = core.link.connections.get(workerId);

      if (
        connection?.isOpen &&
        attachments.length > 0 &&
        !connection.hello.capabilities.includes(
          attachments.some((a) => a.kind !== "image") ? "bot_files_v1" : "bot_images_v1",
        )
      )
        throw new ProviderFailure(
          "configuration",
          "Update this worker to receive files, or choose another worker.",
          "platform",
        );

      if (connection?.isOpen && !connection.hello.capabilities.includes("bot_harness_v1"))
        throw new ProviderFailure(
          "configuration",
          "Update this worker to run bots, or pick another worker.",
          "platform",
        );

      const status = connection?.isOpen
        ? ""
        : `Waiting for ${(await coreWorkers(core)).find((w) => w.id === workerId)?.name || "worker"}`;

      if (status !== lastStatus) {
        core.bots.waiting(turn.id, Boolean(status));
        await run((s) => s.status(turn, status || "Typing…"));
        lastStatus = status;
      }

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
