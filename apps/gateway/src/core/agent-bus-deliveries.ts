import { ui } from "@canopy/contracts";
import { DEFAULT_BUS_LIMITS } from "@canopy/domain";
import { Match } from "effect";
import { AgentBusStore, truncate } from "../store/index.ts";
import { busState } from "./agent-bus-context.ts";
import type { AgentBus } from "./agent-bus.ts";

export interface BusDeliveriesMethods {
  onTurnFinished(turnId: string): Promise<void>;
  deliverNotifications(turnId?: string): Promise<void>;
  deliverAnswers(): Promise<void>;
  onInteraction(interaction: ui.Interaction): Promise<void>;
}

export const busDeliveriesMethods: BusDeliveriesMethods = {
  /** A turn finished: notify the threads that asked to hear about it. */
  async onTurnFinished(this: AgentBus, turnId: string): Promise<void> {
    await this.deliverAnswers();
    await this.deliverNotifications(turnId);
  },

  /** Durable reports: also called by the startup/periodic sweep after a gateway restart. */
  async deliverNotifications(this: AgentBus, turnId?: string): Promise<void> {
    if (!turnId) {
      for (const id of await this[busState].host.run(AgentBusStore.use((s) => s.notificationFallbacks())))
        await this[busState].host.fallbackSteer(id);
    }

    const due = await this[busState].host.run(AgentBusStore.use((s) => s.dueNotifications(turnId)));

    for (const { call, target, turnStatus, lastMessage } of due) {
      const label = target.kind === "side" ? "side thread" : "thread";

      const input = {
        note: `[canopy] The ${label} "${target.title}" (thread_id: ${target.id}) finished a turn: ${turnStatus}. Its last message:`,
        message: truncate(lastMessage, 20_000) || "(no message)",
      };

      const delivery = await this[busState].host.run(AgentBusStore.use((s) => s.deliverNotification(call.id, input)));
      await this[busState].host.inputsChanged(call.source_thread_id);

      if (delivery?.turn) await this[busState].host.queued(call.source_thread_id, delivery.turn);
      else if (delivery?.steerId) await this[busState].host.steered(delivery.steerId);
    }
  },

  async deliverAnswers(this: AgentBus): Promise<void> {
    const due = await this[busState].host.run(AgentBusStore.use((s) => s.deliverAnswers()));

    for (const delivery of due) {
      if (delivery.turn) await this[busState].host.queued(delivery.threadId, delivery.turn);
      else if (delivery.steerId) await this[busState].host.steered(delivery.steerId);
    }
  },

  /** A side thread with interaction_route = parent asks: wake the parent agent with the question. */
  async onInteraction(this: AgentBus, interaction: ui.Interaction): Promise<void> {
    if (interaction.routedTo !== "parent" || interaction.status !== "pending") return;

    const forwarded = await this[busState].host.run(
      AgentBusStore.use((s) =>
        s.forwardInteraction({
          requestId: interaction.requestId,
          maxHops: DEFAULT_BUS_LIMITS.maxHops,
          input: (thread) => {
            const kind = Match.value(interaction.kind).pipe(
              Match.when(1, () => "permission"),
              Match.when(2, () => "question"),
              Match.orElse(() => "form"),
            );

            const how =
              kind === "permission"
                ? `answer_interaction with response "allow" or "deny"`
                : `answer_interaction with response "answer" and answer_json, or "cancel"`;

            // All of it is the platform's; the UI shows the question from the turn's structured source.
            return {
              note:
                `[canopy] Your side thread "${thread.title}" (thread_id: ${thread.id}) is waiting for your answer.\n` +
                `request_id: ${interaction.requestId}\nkind: ${kind}\ntool: ${interaction.toolName}\n` +
                `request: ${truncate(interaction.requestJson, 4_000)}\n\n` +
                `Answer with ${how}. The user can answer in the UI instead.`,
              message: "",
            };
          },
        }),
      ),
    );

    if (forwarded) await this[busState].host.queued(forwarded.parentThreadId, forwarded.turn);
  },
};
