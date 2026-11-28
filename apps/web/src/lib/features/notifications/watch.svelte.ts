import { untrack } from "svelte";
import { isThreadSnoozed } from "@canopy/domain/thread-snooze";
import { botBadgeCount, maxNotificationBadge, threadBadgeCount } from "@canopy/domain/notification-badge";
import { UsageResets, type ResetProvider } from "@canopy/domain/provider-usage-resets";
import type { SettingsState } from "#lib/features/settings/settings-state.svelte.ts";
import { botList } from "#lib/features/bots/bot-list.svelte.ts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { devicePreferences, limitResetDeviceKeys } from "#lib/features/settings/device-preferences.svelte.ts";
import { sharedProxies } from "#lib/features/proxies/proxies.ts";
import { botEvent, botNotice, botSeen, type BotSeen } from "./bot-notices.ts";
import { usageResetReadings } from "./usage-reset-readings.ts";
import { connectNativeClicks, deliver, deliverUsageReset } from "./deliver.ts";
import { trackViewing } from "./notice-claims.ts";
import { connectNotificationSound } from "./notification-sound.ts";
import { notificationEvent, threadNotice } from "./thread-notices.ts";

/** Thread events come from the overview stream, bot events from the shared bot list. */
export function watchNotifications(
  overview: OverviewState,
  settings: SettingsState,
  currentPath: () => string,
): () => void {
  const offSound = connectNotificationSound(() =>
    [devicePreferences.values.threadNotifications, devicePreferences.values.botNotifications].includes("sound"),
  );

  const offClicks = connectNativeClicks();
  const offViewing = trackViewing(currentPath);

  const offThreads = overview.subscribe((update) => {
    if (
      !settings.loaded ||
      !settings.moduleEnabled("threads") ||
      overview.connection !== "live" ||
      update.change.case !== "thread"
    )
      return;
    const thread = update.change.value;
    const before = overview.threads.get(thread.id);

    // Both sides of the transition matter. In particular, a wake must not deliver the current result.
    if (overview.threadSnoozed(thread.id) || isThreadSnoozed(thread, (id) => overview.threads.get(id))) return;
    const event = notificationEvent(before, thread);

    if (event)
      void deliver(threadNotice(overview, thread, event), currentPath(), () => !overview.threadSnoozed(thread.id));
  });

  let known: ReadonlyMap<string, BotSeen> | undefined;
  const proxies = sharedProxies();
  const setBadge = window.canopyDesktop?.setNotificationBadge;

  const offList = $effect.root(() => {
    const watchResets = (provider: ResetProvider) => {
      let resets: UsageResets | undefined;
      let resyncs = overview.resyncs;

      const enabled = () =>
        overview.connection === "live" && devicePreferences.values[limitResetDeviceKeys[provider]] === "on";

      $effect(() => {
        const synced = overview.resyncs;

        if (!enabled()) {
          resets = undefined;

          return;
        }

        if (!resets || resyncs !== synced) resets = new UsageResets(provider, Date.now());
        resyncs = synced;
        const active = resets;
        const readings = usageResetReadings(provider, overview.workers, proxies.data?.proxies ?? []);
        const allowed = () => enabled() && overview.resyncs === synced && resets === active;

        for (const { key, label } of active.observe(readings))
          void untrack(() => deliverUsageReset(provider, key, label, allowed));
      });
    };

    watchResets("claude");
    watchResets("codex");

    $effect(() => {
      if (settings.loaded && settings.moduleEnabled("bots")) return untrack(() => botList.use());
    });

    $effect(() => {
      if (!settings.loaded || !settings.moduleEnabled("bots")) {
        known = undefined;

        return;
      }

      const list = botList.list;

      if (!botList.loaded) return;
      const now = Date.now();

      if (known)
        for (const bot of list) {
          const event = botEvent(known.get(bot.id), bot, now);

          if (!event) continue;
          const threadId = event.kind === "message" ? "" : event.approval.threadId;
          const allowed = () => !threadId || (settings.moduleEnabled("threads") && !overview.threadSnoozed(threadId));

          if (untrack(allowed)) void deliver(botNotice(bot, event), currentPath(), allowed);
        }

      known = new Map(list.map((bot) => [bot.id, botSeen(known?.get(bot.id), bot)]));
    });

    if (setBadge) {
      const threads = $derived(settings.moduleEnabled("threads") ? threadBadgeCount(overview.threads) : 0);
      const bots = $derived(settings.moduleEnabled("bots") ? botBadgeCount(botList.list) : 0);
      const count = $derived(Math.min(threads + bots, maxNotificationBadge));

      $effect(() => {
        if (!settings.loaded || !overview.resyncs || (settings.moduleEnabled("bots") && !botList.loaded)) return;
        void setBadge(count).catch(() => {});
      });
    }
  });

  return () => {
    offSound();
    offClicks?.();
    offViewing();
    offThreads();
    offList();
  };
}
