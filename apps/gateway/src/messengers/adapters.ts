import { Invalid } from "../store/store.ts";
import { messengerLabel, type MessengerAdapter, type MessengerProvider } from "./provider.ts";
import { slackAdapter } from "./slack.ts";

const adapters: Partial<Record<MessengerProvider, MessengerAdapter>> = { slack: slackAdapter };

export function messengerAdapter(provider: MessengerProvider): MessengerAdapter {
  const adapter = adapters[provider];

  if (!adapter) throw new Invalid(`${messengerLabel(provider)} messaging is unavailable`);

  return adapter;
}
