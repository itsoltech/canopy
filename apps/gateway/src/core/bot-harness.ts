import { create, fromJson } from "@bufbuild/protobuf";
import { CommandSchema, CommandResultSchema, TurnOutcome } from "@canopy/contracts";
import { BotStore } from "../bots/store.ts";
import type { ModelInput, ModelReply } from "../bots/types.ts";
import { coreState } from "./core-context.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreWorkers } from "./core-providers.ts";
import { coreDeliver, coreDispatch } from "./core-commands.ts";
import type { GatewayCore } from "./core.ts";

/** Welcome for a worker link: journal cursors of its threads and of its bot harness turns. */
export async function workerJournalWelcome(core: GatewayCore, workerId: string, journalId: string) {
  core[coreState].journalIds.set(workerId, journalId);
  const persisted = journalId ? await coreRun(core, (s) => s.journalCursors(workerId, journalId)) : [];
  const botCursors = journalId ? await core.bots.run((s) => s.harnessCursors(workerId, journalId)) : [];

  return { heartbeatIntervalSeconds: 15, persisted: [...persisted, ...botCursors] };
}

/** A model call attaches to a durable worker command, including after a gateway restart. */
export async function runBotHarness(core: GatewayCore, input: ModelInput): Promise<ModelReply> {
  const turn = input.turn;

  if (!turn) throw new Error("Bot turn is required");
  const run: GatewayCore["bots"]["run"] = (use) => core[coreState].options.runtime.runPromise(BotStore.use(use));
  let job = await run((s) => s.harnessTurn(turn.id));
  let workerId = job?.worker_id || input.configuration.workerId;

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

    candidates.sort(
      (a, b) =>
        Number(core.link.connections.get(b.id)?.hello.environmentKind === "desktop") -
        Number(core.link.connections.get(a.id)?.hello.environmentKind === "desktop"),
    );
    workerId = candidates[0]?.id || "";

    if (!workerId) {
      core.bots.waiting(turn.id, true);
      await run((s) => s.status(turn, "Waiting for a worker"));
      await Bun.sleep(500);
    }
  }

  core.bots.waiting(turn.id, false);

  if (!job) {
    const connection = core.link.connections.get(workerId);

    if (connection?.isOpen && !connection.hello.capabilities.includes("bot_harness_v1"))
      throw new Error("WORKER_UPGRADE_REQUIRED");
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
              historyJson: JSON.stringify(input.messages),
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
        if (job.outcome !== TurnOutcome.COMPLETED) throw new Error(job.error_code || "HARNESS_ERROR");

        return { text: job.text, calls: [] };
      }

      const failure = await run((s) => s.harnessCommandFailure(turn.id));

      if (failure) throw new Error(fromJson(CommandResultSchema, failure).errorCode || "HARNESS_ERROR");
      const connection = core.link.connections.get(workerId);

      if (connection?.isOpen && !connection.hello.capabilities.includes("bot_harness_v1"))
        throw new Error("WORKER_UPGRADE_REQUIRED");

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
