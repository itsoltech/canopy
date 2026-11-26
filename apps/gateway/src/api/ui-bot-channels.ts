import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { slackBotAppManifest } from "../connectors/slack-app.ts";
import { MessengerStore } from "../messengers/store.ts";
import { validateSlackAccount, slackMessengerAppManifest, slackMessengerAppCreateUrl } from "../messengers/slack.ts";
import { type GatewayCore } from "../core/core.ts";
import { coreState } from "../core/core-context.ts";
import { unwrap } from "./ui-errors.ts";
import { Invalid, NotFound } from "../store/index.ts";
import type { UiHandlers } from "./ui-service.ts";

export function botChannelHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "listMessengerAccounts"
  | "saveMessengerAccount"
  | "deleteMessengerAccount"
  | "listBotMessengerRoutes"
  | "saveBotMessengerRoute"
  | "deleteBotMessengerRoute"
> {
  const state = core[coreState];
  const owner = state.options.userId;

  return {
    listMessengerAccounts: () =>
      messengerGuard(async () => {
        const botApp = slackBotAppManifest();

        return create(ui.ListMessengerAccountsResponseSchema, {
          accounts: (await state.options.runtime.runPromise(MessengerStore.use((s) => s.accounts(owner)))).map(
            (account) => create(ui.MessengerAccountSchema, account),
          ),
          slackAppManifest: slackMessengerAppManifest(),
          slackAppCreateUrl: slackMessengerAppCreateUrl(),
          slackBotAppManifest: botApp.manifest,
          slackBotAppCreateUrl: botApp.createUrl,
        });
      }),
    saveMessengerAccount: (r, context) =>
      messengerGuard(async () => {
        const validation = await validateStandaloneEdit(core, r, context.signal);

        const account = await state.options.runtime.runPromise(
          MessengerStore.use((s) =>
            s.saveAccount(owner, {
              ...(r.id && { id: r.id }),
              name: r.name,
              ...(r.connectorAccountId && { connectorAccountId: r.connectorAccountId }),
              ...validation,
              ...(r.enabled !== undefined && { enabled: r.enabled }),
              ...(r.appToken !== undefined && { appToken: r.appToken }),
              ...(r.botToken !== undefined && { botToken: r.botToken }),
            }),
          ),
        );

        core.messengers.wake();

        return create(ui.SaveMessengerAccountResponseSchema, { account: create(ui.MessengerAccountSchema, account) });
      }),
    deleteMessengerAccount: (r) =>
      messengerGuard(async () => {
        await state.options.runtime.runPromise(MessengerStore.use((s) => s.deleteAccount(owner, r.accountId)));
        core.messengers.wake();

        return create(ui.DeleteMessengerAccountResponseSchema);
      }),
    listBotMessengerRoutes: (r) =>
      messengerGuard(async () => {
        await core.bots.get(r.botId);
        const routes = await state.options.runtime.runPromise(MessengerStore.use((s) => s.routes(owner, r.botId)));

        return create(ui.ListBotMessengerRoutesResponseSchema, {
          routes: routes.map((route) => create(ui.BotMessengerRouteSchema, route)),
        });
      }),
    saveBotMessengerRoute: (r) =>
      messengerGuard(async () => {
        if (!r.route) throw new ConnectError("Choose a messenger route and try again.", Code.InvalidArgument);
        const input = r.route;

        if (input.delivery !== "reply" && input.delivery !== "notify")
          throw new ConnectError("Choose how to deliver messages and try again.", Code.InvalidArgument);

        const delivery = input.delivery;

        const route = await state.options.runtime.runPromise(
          MessengerStore.use((s) =>
            s.saveRoute(owner, {
              ...(input.id && { id: input.id }),
              botId: input.botId,
              accountId: input.accountId,
              channelIds: input.channelIds,
              userIds: input.userIds,
              directMessages: input.directMessages,
              mentions: input.mentions,
              observe: input.observe,
              ...(input.channelContext !== undefined && { channelContext: input.channelContext }),
              delivery,
              instructions: input.instructions,
            }),
          ),
        );

        core.messengers.wake();

        return create(ui.SaveBotMessengerRouteResponseSchema, { route: create(ui.BotMessengerRouteSchema, route) });
      }),
    deleteBotMessengerRoute: (r) =>
      messengerGuard(async () => {
        await state.options.runtime.runPromise(MessengerStore.use((s) => s.deleteRoute(owner, r.routeId)));
        core.messengers.wake();

        return create(ui.DeleteBotMessengerRouteResponseSchema);
      }),
  };
}

async function validateStandaloneEdit(core: GatewayCore, request: ui.SaveMessengerAccountRequest, signal: AbortSignal) {
  const { connectorAccountId, id, appToken, botToken } = request;

  if (connectorAccountId || (id && appToken === undefined && botToken === undefined)) return undefined;

  const { runtime, userId, messengerTransport } = core[coreState].options;

  const previous = id
    ? await runtime.runPromise(MessengerStore.use((s) => s.standaloneCredentialsForSave(userId, id)))
    : undefined;

  if (id && !previous) return undefined;

  const { externalId } = await validateSlackAccount(
    {
      appToken: appToken ?? previous?.appToken ?? "",
      botToken: botToken ?? previous?.botToken ?? "",
    },
    signal,
    messengerTransport,
  );

  return { externalId, ...(previous && { validatedRevision: previous.revision }) };
}

/** Never echo or log provider failures, SQL parameters or write-only credentials. */
async function messengerGuard<A>(perform: () => Promise<A>): Promise<A> {
  try {
    return await perform();
  } catch (cause) {
    if (cause instanceof ConnectError) throw cause;
    const failure = unwrap(cause);

    if (failure instanceof Invalid) throw new ConnectError(failure.message, Code.InvalidArgument);

    if (failure instanceof NotFound) throw new ConnectError(failure.message, Code.NotFound);

    throw new ConnectError("Messenger request failed. Check the configuration and try again.", Code.Internal);
  }
}
