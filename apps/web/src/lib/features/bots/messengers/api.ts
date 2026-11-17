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

export function slackIds(text: string, kind: "channel" | "user"): string[] {
  const values = [
    ...new Set(
      text
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];

  const pattern = kind === "channel" ? /^[CG][A-Z0-9]+$/ : /^[UW][A-Z0-9]+$/;

  if (values.some((value) => !pattern.test(value)))
    throw new Error(`Some Slack ${kind} IDs are invalid. Separate valid IDs with commas.`);

  if (kind === "user" && !values.length) throw new Error("No allowed users yet. Add a Slack user ID before saving.");

  return values;
}

/** Each messenger editor saves independently of the surrounding bot form. */
export function saveOnEnter(event: KeyboardEvent, save: () => Promise<void>): void {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  void save();
}

export function messengerStatus(account: ui.MessengerAccount): string {
  if (!account.enabled) return "Paused";

  switch (account.status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "retrying":
      return "Reconnecting…";
    case "needs_reconnect":
      return "Edit tokens to reconnect";
    case "error":
      return "Connection error";
    case "disconnected":
      return "Disconnected";
    default:
      return "Waiting for connection";
  }
}
