import { ui } from "@canopy/contracts";
import { requestJson, type JsonBody } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

export const messengerAccounts = async () =>
  decode(ui.ListMessengerAccountsResponseSchema, await requestJson("GET", "/api/messengers/accounts"));

export const messengerRoutes = async (botId: string) =>
  decode(ui.ListBotMessengerRoutesResponseSchema, await requestJson("GET", `/api/bots/${botId}/messengers`));

export const saveMessengerAccount = async (body: JsonBody) =>
  decode(ui.SaveMessengerAccountResponseSchema, await requestJson("POST", "/api/messengers/accounts", body));

export const saveMessengerRoute = async (botId: string, route: JsonBody) =>
  decode(ui.SaveBotMessengerRouteResponseSchema, await requestJson("POST", `/api/bots/${botId}/messengers`, { route }));

export const deleteMessengerAccount = (id: string) => requestJson("DELETE", `/api/messengers/accounts/${id}`);
export const deleteMessengerRoute = (id: string) => requestJson("DELETE", `/api/messengers/routes/${id}`);

/** Each messenger editor saves independently of the surrounding bot form. */
export function saveOnEnter(event: KeyboardEvent, save: () => Promise<void>): void {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  void save();
}

export function messengerStatus(account?: ui.MessengerAccount): string {
  if (!account) return "Account unavailable";

  if (!account.enabled) return "Paused";

  switch (account.status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "retrying":
      return "Reconnecting…";
    case "needs_authorization":
      return "Authorization needed";
    case "needs_reconnect":
      return "Reconnect needed";
    case "error":
      return "Connection error";
    case "disconnected":
      return "Disconnected";
    default:
      return "Waiting for connection";
  }
}
