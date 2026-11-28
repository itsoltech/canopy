import { create } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import sharp from "sharp";
import type { TestGateway } from "./gateway.ts";

export async function botForMove(
  gateway: TestGateway,
  name: string,
  permissions: Pick<bots.BotConfiguration, "approvalPolicy"> & Partial<Pick<bots.BotConfiguration, "threadPermission">>,
) {
  const created = await gateway.api.createBot({
    configuration: create(bots.BotConfigurationSchema, {
      name,
      shape: "round",
      color: "#22aaff",
      provider: Provider.CODEX,
      providerInstance: "bot-fixture",
      model: "gpt-6.1-sol",
      ...permissions,
    }),
    clientRequestId: crypto.randomUUID(),
  });

  return created.bot!.id;
}

/** Both sent and unsent images must follow a bot to its new home. */
export async function botComposerForMove(gateway: TestGateway, botId: string) {
  const data = new Uint8Array(
    await sharp({ create: { width: 24, height: 16, channels: 3, background: "#12abcd" } })
      .png()
      .toBuffer(),
  );

  const image = (await gateway.api.uploadAttachment({ botId, name: "sent.png", data })).attachment!;
  await gateway.api.sendBotMessage({
    botId,
    text: "my favourite colour is teal",
    attachmentIds: [image.id],
    clientRequestId: crypto.randomUUID(),
  });
  const pending = (await gateway.api.uploadAttachment({ botId, name: "draft.png", data })).attachment!;

  const draft = await gateway.api.saveBotDraft({
    botId,
    expectedRevision: 0n,
    draft: {
      text: "Unsent message",
      attachments: [pending],
      clientRequestId: "move-draft",
      quotes: [{ text: "Original", sourceKind: "agent_message", sourceThreadId: botId }],
    },
  });

  return { image, pending, draft };
}

/** Upload, draft CAS and atomic send all route to the same linked home. */
export async function sendRemoteBotImage(gateway: TestGateway, botId: string, revision: bigint, data: Uint8Array) {
  const image = (await gateway.api.uploadAttachment({ botId, name: "remote.png", data })).attachment!;

  const saved = await gateway.api.saveBotDraft({
    botId,
    expectedRevision: revision,
    draft: { text: "Remote image", attachments: [image], clientRequestId: crypto.randomUUID() },
  });

  await gateway.api.sendBotMessage({
    botId,
    text: saved.text,
    attachmentIds: [image.id],
    clientRequestId: saved.clientRequestId,
    draftRevision: saved.revision,
  });
}
