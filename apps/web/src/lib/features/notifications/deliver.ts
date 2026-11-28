import { goto } from "$app/navigation";
import type { ResetProvider } from "@canopy/domain/provider-usage-resets";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { toast, type ToastTone } from "#lib/shared/ui/toast.svelte.ts";
import { playNotificationSound } from "./notification-sound.ts";
import { claimNotice, viewedElsewhere } from "./notice-claims.ts";

/** One thread or bot event, ready to show: the same text in every tab, window and computer. */
export interface Notice {
  /** Equal for the same event everywhere (unqualified ids), so only one tab or window shows it. */
  readonly key: string;
  readonly setting: "threadNotifications" | "botNotifications";
  /** The thread or bot chat it opens; also how "already looking at it" is decided. */
  readonly path: string;
  readonly title: string;
  readonly body: string;
  /** In-app event heading, followed by the thread title or bot name. */
  readonly toast: string;
  readonly toastDescription: string;
  readonly action: string;
  readonly tone: ToastTone;
  /** Already read on another device: only a window showing it still plays the sound. */
  readonly read?: boolean;
}

const focused = () => document.hasFocus() && !document.hidden;

const open = (path: string) => {
  window.focus();
  void goto(path);
};

function showSystem(notice: Pick<Notice, "key" | "title" | "body" | "path">, sound: boolean): void {
  const desktop = window.canopyDesktop;

  if (desktop?.showNotification) {
    const { key, title, body, path } = notice;

    // Main accepts 200 and 600 characters (apps/desktop/src/notifications.ts).
    void desktop
      .showNotification({ key, title: title.slice(0, 200), body: body.slice(0, 600), path, sound })
      .catch(() => undefined);

    return;
  }

  if (!("Notification" in window) || Notification.permission !== "granted") return;

  try {
    const shown = new Notification(notice.title, { body: notice.body, tag: `canopy:${notice.key}`, silent: true });
    shown.onclick = () => {
      shown.close();
      open(notice.path);
    };

    if (sound) playNotificationSound();
  } catch {
    // Some mobile browsers expose Notification but only support service-worker notifications.
  }
}

/**
 * Looking at it (a focused, visible window on that path, here or in another tab): no popup or toast, only the
 * sound when it is on. Otherwise a toast in the focused window and one system notification across all of them.
 */
export async function deliver(notice: Notice, currentPath: string, allowed: () => boolean): Promise<void> {
  const device = devicePreferences.values;
  const choice = device[notice.setting];
  const sound = choice === "sound";
  const here = focused();

  if ((here && currentPath === notice.path) || viewedElsewhere(notice.path)) {
    if (sound && (await claimNotice(notice.key)) && allowed()) playNotificationSound();

    return;
  }

  if (notice.read) return;

  if (here && device.inAppNotifications === "on")
    toast(notice.toast, {
      description: notice.toastDescription,
      tone: notice.tone,
      action: { label: notice.action, run: () => open(notice.path) },
    });

  if (choice !== "off" && (await claimNotice(notice.key)) && allowed()) showSystem(notice, sound);
}

export async function deliverUsageReset(
  provider: ResetProvider,
  key: string,
  label: string,
  allowed: () => boolean,
): Promise<void> {
  const title = provider === "claude" ? "Claude usage limit reset" : "Codex usage limit reset";
  const path = "/settings/providers";

  const inApp = async () => {
    const canToast = () => focused() && devicePreferences.values.inAppNotifications === "on" && allowed();

    if (canToast() && (await claimNotice(`${key}:toast`)) && canToast())
      toast(title, {
        description: label,
        tone: "info",
        action: { label: "Open provider settings", run: () => open(path) },
      });
  };

  const system = async () => {
    if ((await claimNotice(key)) && allowed()) showSystem({ key, title, body: label, path }, false);
  };

  await Promise.all([inApp(), system()]);
}

/** Desktop: a click on a native notification focuses the window in main, then navigates here. */
export function connectNativeClicks(): (() => void) | undefined {
  return window.canopyDesktop?.onNotificationClick?.((path) => void goto(path));
}
