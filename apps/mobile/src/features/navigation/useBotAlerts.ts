import { useEffect, useEffectEvent, useRef } from "react";
import type { bots as botContract } from "@canopy/contracts";
import { botEvent, botSeen, displayText, type BotSeen } from "@canopy/domain/bot-chat";
import { noticePreview } from "@canopy/domain/notice-preview";
import { useSession } from "../../state/session";
import { useBotList } from "../../state/bot-list";
import { useDevicePreferences } from "../settings/device-preferences";

export interface InAppAlert {
  id: string;
  kind: "thread" | "bot";
  title: string;
  status: string;
}

type Baseline = { connection: string; list: botContract.ListBotsResponse | undefined; seen?: Map<string, BotSeen> };

/**
 * Alerts from the shared bot list. Each foreground connection begins with a baseline: the first list read after
 * it, so waking or reconnecting never replays history. A failed read starts a new baseline too.
 */
export function useBotAlerts(currentId: string | undefined, show: (alert: InAppAlert) => void) {
  const { client, active, online, epoch } = useSession();
  const { values, loaded } = useDevicePreferences();
  const list = useBotList();
  const connection = `${Boolean(client)}:${active}:${online}:${epoch}`;
  const baseline = useRef<Baseline>({ connection: "", list: undefined });

  const deliver = useEffectEvent((alert: InAppAlert) => {
    if (loaded && active && values.inAppNotifications === "on" && alert.id !== currentId) show(alert);
  });

  useEffect(() => {
    if (list.error) baseline.current = { ...baseline.current, seen: undefined };
  }, [list.error]);

  useEffect(() => {
    const current = baseline.current;

    if (current.connection !== connection) {
      baseline.current = { connection, list: list.data };

      return;
    }

    if (!list.data || list.data === current.list || !active || !online) return;
    const next = new Map<string, BotSeen>();

    for (const bot of list.data.bots) {
      const seen = current.seen?.get(bot.id);
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

    baseline.current = { connection, list: list.data, seen: next };
  }, [connection, list.data, active, online]);
}
