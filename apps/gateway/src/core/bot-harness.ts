import { create, fromJson } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { CommandSchema, CommandResultSchema, TurnOutcome } from "@canopy/contracts";
import { classifyFailure, ProviderFailure } from "@canopy/domain";
import { budgetedHistory } from "../bots/history-budget.ts";
import { BotStore } from "../bots/store.ts";
import type { BotTurn, ModelInput, ModelReply } from "../bots/types.ts";
import { coreState } from "./core-context.ts";
import { coreWorkers } from "./core-providers.ts";
import { coreDeliver, coreDispatch } from "./core-commands.ts";
import { coreRun } from "./core-broadcast.ts";
import type { GatewayCore } from "./core.ts";

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

/** A model call attaches to a durable worker command, including after a gateway restart. */
export async function runBotHarness(core: GatewayCore, input: ModelInput): Promise<ModelReply> {
  const turn = input.turn;

  if (!turn) throw new Error("Bot turn is required");
  const run: GatewayCore["bots"]["run"] = (use) => core[coreState].options.runtime.runPromise(BotStore.use(use));
  let job = await run((s) => s.harnessTurn(turn.id));
  const workerId = await botWorker(core, input, turn, job?.worker_id || input.configuration.workerId);
  core.bots.waiting(turn.id, false);

  if (!job) {
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
              configurationKey: createHash("sha256")
                .update(
                  JSON.stringify({
                    name: input.configuration.name,
                    instructions: input.configuration.instructions,
                    approvalPolicy: input.configuration.approvalPolicy,
                  }),
                )
                .digest("hex"),
              historyJson: JSON.stringify(budgetedHistory(input.messages)),
              input: input.messages.findLast((m) => m.role === "user")?.text ?? "",
              tools: input.tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchemaJson: JSON.stringify(t.parameters),
              })),
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

      if (job?.outcome !== null && job?.outcome !== undefined) {
        if (job.outcome !== TurnOutcome.COMPLETED)
          throw new ProviderFailure(
            classifyFailure(job.reason, job.error_class || job.error_code || "HARNESS_ERROR"),
            "Bot harness could not finish this turn",
            "harness",
          );

        return { text: job.text, calls: [] };
      }

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
    if (input.signal.aborted && !core.bots.stopping)
      void coreDispatch(
        core,
        workerId,
        { kind: { case: "interruptBotTurn", value: { threadId: turn.bot_id, turnId: turn.id } } },
        { ttlSeconds: 86400 },
      );
  }
}
