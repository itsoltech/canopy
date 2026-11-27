import type { ActivityNotchItem } from "@canopy/ui/desktop";
import { botList } from "#lib/features/bots/bot-list.svelte.ts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import type { SettingsState } from "#lib/features/settings/settings-state.svelte.ts";
import { ActivityNotchProjectMarks } from "./activity-notch-project-marks.ts";
import { activityNotchSnapshot } from "./activity-notch.ts";
import type { GatewayCapabilities } from "./gateway-capabilities.svelte.ts";

export function watchActivityNotch(
  overview: OverviewState,
  settings: SettingsState,
  gateway: GatewayCapabilities,
): (() => void) | undefined {
  const setActivityNotch = window.canopyDesktop?.setActivityNotch;

  if (!setActivityNotch) return;
  let lastSnapshot: string | undefined;
  let active = $state(true);
  let timeRevision = $state(0);
  let imageRevision = $state(0);
  const projectMarks = new ActivityNotchProjectMarks(() => imageRevision++);

  const publish = (items: readonly ActivityNotchItem[]) => {
    const key = JSON.stringify(items);

    if (key === lastSnapshot) return;
    lastSnapshot = key;
    void setActivityNotch(items).catch(() => {
      if (lastSnapshot === key) lastSnapshot = undefined;
    });
  };

  const stop = $effect.root(() => {
    $effect(() => {
      if (
        !active ||
        devicePreferences.values.activityNotch !== "on" ||
        overview.connection !== "live" ||
        !overview.resyncs ||
        gateway.state === "unavailable" ||
        gateway.incompatible ||
        !settings.loaded
      ) {
        projectMarks.clear();
        publish([]);

        return;
      }

      const threads = settings.moduleEnabled("threads") && gateway.supportsMethod("ListThreads");

      const bots =
        settings.moduleEnabled("bots") && gateway.supportsMethod("ListBots") && botList.synchronized && !botList.error;

      void timeRevision;
      void imageRevision;

      const now = Date.now();
      const visibleImages = new Set<string>();

      const { items, expiresAt } = activityNotchSnapshot({
        threads: threads ? overview.threads : undefined,
        bots: bots ? botList.list : [],
        computers: overview.computers,
        staleBotHomes: new Set(
          bots ? [...botList.unavailableComputers, ...botList.refreshingComputers].map((home) => home.nodeId) : [],
        ),
        botExecuting: (id) => botList.executing(id),
        markForProject: (id) => projectMarks.mark(overview.project(id), visibleImages),
        placeOf: (thread) => overview.worker(thread.workerId)?.name || overview.machine(thread.nodeId),
        now,
      });

      projectMarks.retain(visibleImages);
      publish(items);

      if (!Number.isFinite(expiresAt)) return;

      const timer = setTimeout(() => timeRevision++, Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now())));

      return () => clearTimeout(timer);
    });
  });

  const hide = () => {
    active = false;
    projectMarks.clear();
    publish([]);
  };

  const show = () => {
    active = true;
  };

  const refreshTime = () => {
    if (!document.hidden) timeRevision++;
  };

  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  document.addEventListener("visibilitychange", refreshTime);

  return () => {
    stop();
    projectMarks.clear();
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", show);
    document.removeEventListener("visibilitychange", refreshTime);
    publish([]);
  };
}
