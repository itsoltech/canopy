import { useEffect, useEffectEvent } from "react";
import { botEvent, botSeen, displayText, type BotSeen } from "@canopy/domain/bot-chat";
import { noticePreview } from "@canopy/domain/notice-preview";
import { useSession } from "../../state/session";
import { useDevicePreferences } from "../settings/device-preferences";

export interface InAppAlert {
  id: string;
  kind: "thread" | "bot";
  title: string;
  status: string;
}

/** Each foreground connection begins with a baseline, so waking or reconnecting never replays history. */
export function useBotAlerts(currentId: string | undefined, show: (alert: InAppAlert) => void) {
  const { client, active, online, epoch } = useSession();
  const { values, loaded } = useDevicePreferences();

  const deliver = useEffectEvent((alert: InAppAlert) => {
    if (loaded && active && values.inAppNotifications === "on" && alert.id !== currentId) show(alert);
  });

  useEffect(() => {
    if (!client || !active || !online) return;
    let disposed = false;
    let running = false;
    let previous = new Map<string, BotSeen>();
    const api = client.api;

    async function load() {
      if (running) return;
      running = true;

      try {
        const { bots } = await api.listBots({ includeArchived: true });

        if (disposed) return;
        const next = new Map<string, BotSeen>();

        for (const bot of bots) {
          const seen = previous.get(bot.id);
          const event = botEvent(seen, bot, Date.now());
          next.set(bot.id, botSeen(seen, bot));

          if (!event || (event.kind === "message" && !bot.unreadCount)) continue;

          const status =
            event.kind === "message"
              ? noticePreview(displayText(event.message)) || "New message"
              : event.kind === "answer"
                ? "Needs your answer"
                : "Needs your approval";

          deliver({ id: bot.id, kind: "bot", title: bot.configuration?.name || "Bot", status });
        }

        previous = next;
      } catch {
        // A disconnected list is not an event. Reconnect with a fresh baseline.
        previous = new Map();
      } finally {
        running = false;
      }
    }

    void load();
    const timer = setInterval(() => void load(), 10_000);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client, active, online, epoch]);
}
