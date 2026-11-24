import { ItemStatus, TurnEndSource, TurnOutcome, type ThreadSpec, type UserInput } from "@canopy/contracts";
import { classifyFailure, safeFailureDetail } from "@canopy/domain";
import { sessionSelect, type PromptEvent } from "@canopy/acp";
import type { ThreadEventInit } from "../../journal/index.ts";
import { threadSecretOutputGuard } from "../../runtime/thread-secrets.ts";
import type { TurnSettings } from "../turn-input.ts";
import { TurnAdmissionCancelled } from "../turn-input.ts";
import { acpPrompt } from "./input.ts";
import type { AcpThreadOptions, AcpThreadSession, AcpProvider } from "./thread-types.ts";

function beginTurn(turnId: string, model: string, input: UserInput): ThreadEventInit[] {
  return [
    { turnId, body: { case: "turnStarted", value: { model } } },
    {
      turnId,
      body: {
        case: "itemCompleted",
        value: {
          item: {
            itemId: `${turnId}:input`,
            status: ItemStatus.COMPLETED,
            content: { case: "userMessage", value: { text: input.text, clientId: turnId, mentions: input.mentions } },
          },
        },
      },
    },
  ];
}

export async function runAcpTurn(
  provider: AcpProvider,
  options: AcpThreadOptions,
  entry: AcpThreadSession,
  spec: ThreadSpec,
  turnId: string,
  input: UserInput,
  signal: AbortSignal,
  settings?: TurnSettings,
): Promise<void> {
  const mapper = entry.mapper(turnId);
  const record = (init: ThreadEventInit) => options.record(spec.threadId, init);

  const model =
    settings?.model ||
    spec.model ||
    sessionSelect(entry.session, "model")?.currentValue ||
    entry.session.models?.currentModelId ||
    "";

  for (const event of beginTurn(turnId, model, input)) await record(event);

  let reason = "";
  let outcome = TurnOutcome.COMPLETED;
  let errorCode = "";
  let completion: Extract<PromptEvent, { type: "complete" }> | undefined;

  try {
    const prompt = await acpPrompt(
      spec.instructions,
      settings?.connectorNote ? { ...input, text: `${input.text}\n\n${settings.connectorNote}` } : input,
      entry.client.capabilities?.agentCapabilities?.promptCapabilities?.image === true,
    );

    if (settings?.habitContext) prompt.push({ type: "text", text: settings.habitContext });

    if (signal.aborted || settings?.canSubmit?.() === false) throw new TurnAdmissionCancelled();

    for await (const event of entry.client.prompt(entry.session.sessionId, prompt)) {
      if (event.type === "complete") {
        completion = event;

        for (const init of await mapper.complete(event)) await record(init);
      } else {
        const update = event.update;

        for (const init of mapper.update(update)) await record(init);
      }
    }

    if (completion?.stopReason === "cancelled") {
      outcome = TurnOutcome.INTERRUPTED;
      reason = `${provider.name} cancelled the turn`;
    } else if (completion?.stopReason !== "end_turn") {
      const known = ["max_tokens", "max_turn_requests", "refusal"];
      const stop = completion?.stopReason ?? "";
      outcome = TurnOutcome.FAILED;
      reason = `${provider.name} stopped: ${known.includes(stop) ? stop : "unknown stop reason"}`;
      errorCode = classifyFailure(reason);
    }
  } catch (error) {
    outcome = TurnOutcome.FAILED;
    reason = safeFailureDetail(
      threadSecretOutputGuard(spec.threadId).redact(
        error instanceof Error ? error.message : `${provider.name} CLI failed`,
      ),
    );
    errorCode = classifyFailure(reason);
    await entry.dispose();
  } finally {
    if (signal.aborted) {
      outcome = TurnOutcome.INTERRUPTED;
      reason = "interrupted by the user";
      errorCode = "";
    }

    for (const init of mapper.finish(outcome === TurnOutcome.COMPLETED ? ItemStatus.COMPLETED : ItemStatus.INTERRUPTED))
      await record(init);
    await record({
      turnId,
      body: {
        case: "turnFinished",
        value: {
          outcome,
          reason,
          errorCode,
          source: signal.aborted ? TurnEndSource.USER : TurnEndSource.HARNESS,
          providerTurnRef: entry.session.sessionId,
          ...(mapper.usage.length === 1 && { usage: mapper.usage[0] }),
        },
      },
    });
  }
}
