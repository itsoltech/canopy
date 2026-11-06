import { botList } from "#lib/features/bots/bot-list.svelte.ts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { botEvent, botNotice, botSeen, type BotSeen } from "./bot-notices.ts";
import { connectNativeClicks, deliver } from "./deliver.ts";
import { trackViewing } from "./notice-claims.ts";
import { connectNotificationSound } from "./notification-sound.ts";
import { notificationEvent, threadNotice } from "./thread-notices.ts";

/** Thread events come live from the overview stream; bot events from the shared bot list (refreshed every 5 s). */
export function watchNotifications(overview: OverviewState, currentPath: () => string): () => void {
  const offSound = connectNotificationSound(() =>
    [devicePreferences.values.threadNotifications, devicePreferences.values.botNotifications].includes("sound"),
  );

  const offClicks = connectNativeClicks();
  const offViewing = trackViewing(currentPath);

  const offThreads = overview.subscribe((update) => {
    if (overview.connection !== "live" || update.change.case !== "thread") return;
    const thread = update.change.value;
    const event = notificationEvent(overview.threads.get(thread.id), thread);

    if (event) void deliver(threadNotice(overview, thread, event), currentPath());
  });

  const offBots = botList.use();
  let known: ReadonlyMap<string, BotSeen> | undefined;

  const offList = $effect.root(() => {
    $effect(() => {
      const list = botList.list;

      if (!botList.loaded) return;
      const now = Date.now();

      if (known)
        for (const bot of list) {
          const event = botEvent(known.get(bot.id), bot, now);

          if (event) void deliver(botNotice(bot, event), currentPath());
        }

      known = new Map(list.map((bot) => [bot.id, botSeen(known?.get(bot.id), bot)]));
    });
  });

  return () => {
    offSound();
    offClicks?.();
    offViewing();
    offThreads();
    offBots();
    offList();
  };
}
