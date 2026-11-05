import { clone, create } from "@bufbuild/protobuf";
import { ui, type computerLink } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import type { LinkedAgents } from "./agents.ts";
import type { Actor } from "./agents-context.ts";

/** Only the authenticated home supplies display data. It never grants authority over an actor. */
export async function localAgentSender(host: LinkedAgents, actor: Actor): Promise<ui.AgentSender> {
  if (actor.kind === "bot") {
    const bot = await host.core.bots.get(actor.id);
    const config = bot.configuration;

    return create(ui.AgentSenderSchema, {
      botId: actor.id,
      title: config?.name || actor.name,
      botShape: config?.shape ?? "",
      botColor: config?.color ?? "",
      ...(config && { provider: config.provider, providerProfileId: config.providerInstance, model: config.model }),
    });
  }

  const thread = await host.core.getThread(actor.id);

  return create(ui.AgentSenderSchema, {
    threadId: thread.id,
    title: thread.title,
    provider: thread.provider,
    providerProfileId: thread.providerProfileId,
    model: thread.model,
    projectId: thread.projectId,
    workerId: thread.workerId,
  });
}

export async function receivedAgentSender(host: LinkedAgents, node: string, call: computerLink.LinkedAgentCall) {
  const peer = await host.core.computers!.computer(node);
  const sender = call.sender ? clone(ui.AgentSenderSchema, call.sender) : create(ui.AgentSenderSchema);
  // The mTLS peer and envelope actor determine the identity, never ids in display metadata.
  sender.botId = call.actorKind === "bot" ? qualifyId(call.actorId, node) : "";
  sender.threadId = call.actorKind === "thread" ? qualifyId(call.actorId, node) : "";
  sender.projectId = qualifyId(sender.projectId, node);
  sender.workerId = qualifyId(sender.workerId, node);
  sender.computerName = peer?.displayName || peer?.name || "Linked computer";
  sender.title ||= call.actorKind === "bot" ? "a bot" : "another thread";

  return sender;
}
