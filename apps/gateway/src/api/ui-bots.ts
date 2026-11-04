import { create } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import { type GatewayCore } from "../core/core.ts";
import { connectorGuard, guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function botsHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "createBot"
  | "updateBot"
  | "deleteBot"
  | "listBots"
  | "archiveBot"
  | "unarchiveBot"
  | "getBot"
  | "getBotProviderInstances"
  | "sendBotMessage"
  | "watchBotConversation"
  | "readBotExchange"
  | "answerBotApproval"
  | "interruptBot"
  | "retryBot"
  | "setBotRoutineEnabled"
  | "deleteBotRoutine"
  | "cancelBotReminder"
  | "markBotRead"
  | "saveBotMcpServer"
  | "listBotMcpServers"
  | "deleteBotMcpServer"
  | "testBotMcpServer"
> {
  return {
    createBot: (r) => guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.create(r) })),

    updateBot: (r) => guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.update(r) })),

    deleteBot: (r) =>
      guard(async () => {
        await core.bots.remove(r.botId);

        return create(bots.DeleteBotResponseSchema);
      }),

    listBots: (r) =>
      guard(async () => create(bots.ListBotsResponseSchema, { bots: await core.bots.list(r.includeArchived) })),

    archiveBot: (r) =>
      guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.archive(r.botId, true) })),

    unarchiveBot: (r) =>
      guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.archive(r.botId, false) })),

    getBot: (r) => guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.get(r.botId) })),

    getBotProviderInstances: (r) =>
      guard(async () => {
        await core.bots.get(r.botId);

        const instances = (await core.listProviderInstances()).map((i) =>
          create(ui.ProviderInstanceSchema, {
            id: i.id,
            harness: i.harness,
            label: i.label,
            kind: i.kind,
            accentColor: i.accentColor,
            models: i.models,
          }),
        );

        return create(ui.ListProviderInstancesResponseSchema, { instances });
      }),

    sendBotMessage: (r) =>
      guard(async () => create(bots.SendBotMessageResponseSchema, { turnId: await core.bots.send(r) })),

    watchBotConversation: (r, context) => core.bots.watch(r.botId, context.signal),

    readBotExchange: (r) =>
      guard(async () =>
        create(bots.ReadBotExchangeResponseSchema, { messages: await core.bots.exchange(r.exchangeId) }),
      ),

    answerBotApproval: (r) =>
      guard(async () => create(bots.AnswerBotApprovalResponseSchema, { approval: await core.bots.answer(r) })),

    interruptBot: (r) =>
      guard(async () => {
        await core.bots.interrupt(r.botId);

        return create(bots.InterruptBotResponseSchema);
      }),

    retryBot: (r) =>
      guard(async () => {
        await core.bots.retry(r.botId);

        return create(bots.RetryBotResponseSchema);
      }),

    setBotRoutineEnabled: (r) =>
      guard(async () => create(bots.BotRoutineResponseSchema, { routine: await core.bots.setRoutineEnabled(r) })),

    deleteBotRoutine: (r) =>
      guard(async () => {
        await core.bots.deleteRoutine(r);

        return create(bots.DeleteBotRoutineResponseSchema);
      }),

    cancelBotReminder: (r) =>
      guard(async () => {
        await core.bots.cancelReminder(r);

        return create(bots.CancelBotReminderResponseSchema);
      }),

    markBotRead: (r) => guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.markRead(r) })),

    saveBotMcpServer: (r) =>
      connectorGuard(async () =>
        create(bots.SaveBotMcpServerResponseSchema, { server: await core.bots.saveServer(r) }),
      ),

    listBotMcpServers: () =>
      connectorGuard(async () => create(bots.ListBotMcpServersResponseSchema, { servers: await core.bots.servers() })),

    deleteBotMcpServer: (r) =>
      connectorGuard(async () => {
        await core.bots.deleteServer(r.serverId);

        return create(bots.DeleteBotMcpServerResponseSchema);
      }),

    testBotMcpServer: (r) =>
      connectorGuard(async () =>
        create(bots.TestBotMcpServerResponseSchema, { tools: await core.bots.testServer(r.serverId) }),
      ),
  };
}
