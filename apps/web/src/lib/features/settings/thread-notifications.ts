import type { ui } from "@canopy/contracts";
import { goto } from "$app/navigation";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { needsYou } from "#lib/features/threads/activity.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { devicePreferences } from "./device-preferences.svelte.ts";
import { playNotificationSound, connectNotificationSound } from "./notification-sound.ts";

const busy = (thread: ui.Thread) => thread.status === "running" || thread.status === "creating";

/**
 * Snapshots/reconnects establish a baseline; only live transitions of already visible threads alert.
 * A result alerts once, when its turn ends: a new turn starting next to an unseen result does not.
 */
export function notificationEvent(
  before: ui.Thread | undefined,
  next: ui.Thread,
): "completed" | "failed" | "input" | undefined {
  if (!before || next.deletedAt || next.status === "archived") return;

  if (needsYou(next) && (!needsYou(before) || next.pendingInteractions > before.pendingInteractions)) return "input";

  if (busy(next)) return;
  const result = next.unseenResult;

  if ((result === "completed" || result === "failed") && (result !== before.unseenResult || busy(before)))
    return result;

  return undefined;
}

const messages = {
  completed: "A thread finished.",
  failed: "A thread failed.",
  input: "A thread needs your input or approval.",
};

export function watchThreadNotifications(overview: OverviewState, currentId: () => string | undefined): () => void {
  const offSound = connectNotificationSound(
    () => !window.canopyDesktop && devicePreferences.values.threadNotifications === "sound",
  );

  const nativeClick = window.canopyDesktop?.onThreadNotificationClick?.((id) => {
    void goto(`/threads/${encodeURIComponent(id)}`);
  });

  const off = overview.subscribe((update) => {
    if (overview.connection !== "live" || update.change.case !== "thread") return;
    const thread = update.change.value;
    const event = notificationEvent(overview.threads.get(thread.id), thread);

    if (!event) return;
    const focused = document.hasFocus() && !document.hidden;

    if (focused && currentId() === thread.id) return;
    const body = messages[event];

    const open = () => {
      window.focus();
      void goto(`/threads/${encodeURIComponent(thread.id)}`);
    };

    const device = devicePreferences.values;

    if (focused && device.inAppNotifications === "on")
      toast(body, { tone: event === "failed" ? "error" : "info", action: { label: "Open thread", run: open } });

    if (device.threadNotifications === "off") return;
    const sound = device.threadNotifications === "sound";

    if (window.canopyDesktop?.showThreadNotification) {
      void window.canopyDesktop.showThreadNotification({ threadId: thread.id, event, sound }).catch(() => undefined);
    } else if ("Notification" in window && Notification.permission === "granted") {
      try {
        const notification = new Notification("Canopy", { body, tag: `canopy:${thread.id}`, silent: true });
        notification.onclick = () => {
          notification.close();
          open();
        };

        if (sound) playNotificationSound();
      } catch {
        // Some mobile browsers expose Notification but only support service-worker notifications.
      }
    }
  });

  return () => {
    offSound();
    off();
    nativeClick?.();
  };
}
