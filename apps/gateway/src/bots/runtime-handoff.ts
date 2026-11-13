import { fromJson } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { SettingsStore } from "../store/settings.ts";
import { HANDOFF_PROMPT } from "./handoffs.ts";
import type { BotRuntimeOptions, BotsRuntime } from "./runtime.ts";
import type { BotModel, BotTurn, ModelInput } from "./types.ts";

type HandoffContext = {
  options: BotRuntimeOptions;
  run: BotsRuntime["run"];
  now: () => Date;
  stopping: () => boolean;
  reply: (botId: string, input: ModelInput, instanceLabel?: string) => ReturnType<BotModel>;
};

/** A configuration barrier retains its checkpoint, deadline and fallback independently of queue polling. */
export async function runHandoff(ctx: HandoffContext, turn: BotTurn, abort: AbortController): Promise<void> {
  const config = fromJson(bots.BotConfigurationSchema, turn.handoff_configuration);
  const remaining = new Date(turn.handoff_deadline!).getTime() - Date.now();
  const timer = setTimeout(() => abort.abort(new Error("handoff deadline exceeded")), Math.max(0, remaining));
  let note: string;
  let reason = "";

  try {
    const messages = turn.checkpoint.length ? turn.checkpoint : await ctx.run((s) => s.history(turn));
    const saved = messages.at(-1)?.role === "assistant" ? messages.at(-1) : undefined;

    if (saved) {
      if (saved.calls?.length || !saved.text.trim()) throw new Error("invalid handoff response");
      note = saved.text;
    } else {
      if (remaining <= 0) throw new Error("handoff deadline exceeded");
      const context = await ctx.run((s) => s.handoffContext(turn));

      const timezone =
        (await ctx.options.runtime.runPromise(SettingsStore.use((s) => s.user(ctx.options.userId)))).timezone || "UTC";

      const time = `Current time: ${ctx.now().toISOString()} (UTC). User timezone: ${timezone}.`;

      // A provider (or test model) ignoring AbortSignal must not hold up the bot queue.
      const reply = await new Promise<Awaited<ReturnType<BotModel>>>((resolve, reject) => {
        const stopped = () => reject(new Error("handoff aborted"));
        abort.signal.addEventListener("abort", stopped, { once: true });

        if (abort.signal.aborted) {
          stopped();

          return;
        }

        void ctx
          .reply(
            turn.bot_id,
            {
              configuration: config,
              turn,
              instructions: `You are ${config.name}, a conversational assistant inside Canopy. ${time}\n${config.instructions}\n\n${HANDOFF_PROMPT}\n\n${context}`,
              messages,
              tools: [],
              signal: abort.signal,
            },
            turn.handoff_instance_label ?? undefined,
          )
          .then(resolve, reject)
          .finally(() => abort.signal.removeEventListener("abort", stopped));
      });

      abort.signal.throwIfAborted();

      if (reply.calls.length || !reply.text.trim()) throw new Error("invalid handoff response");
      note = reply.text.slice(0, 32000);
      await ctx.run((s) => s.checkpoint(turn, [...messages, { role: "assistant", text: note }]));
    }
  } catch (error) {
    if (ctx.stopping()) throw error;
    reason =
      remaining <= 0 || Date.now() >= new Date(turn.handoff_deadline!).getTime()
        ? "deadline_exceeded"
        : "source_unavailable_or_failed";
    note = await ctx.run((s) => s.handoffFallback(turn));
  } finally {
    clearTimeout(timer);
  }

  await ctx.run((s) => s.finishHandoff(turn, config.model, note, reason));

  if (reason) ctx.options.log?.(`bots: handoff fallback (${reason})`);
}
