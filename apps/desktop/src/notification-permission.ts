import { app, Notification } from "electron";
import { join } from "node:path";
import type { DesktopNotificationPermission, DesktopNotificationPermissionStatus } from "@canopy/ui/desktop";

let native: DesktopNotificationPermission | undefined;
let pendingRequest: Promise<DesktopNotificationPermissionStatus> | undefined;

function macPermission(): DesktopNotificationPermission {
  const directory = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build");

  // SAFETY: This path loads the Canopy N-API addon, which exports status() and request() with this contract.
  return (native ??= require(join(directory, "native/notification-permission.node")) as DesktopNotificationPermission);
}

export function notificationPermission(): Promise<DesktopNotificationPermissionStatus> {
  return macPermission().status();
}

export function requestNotificationPermission(): Promise<DesktopNotificationPermissionStatus> {
  return (pendingRequest ??= macPermission()
    .request()
    .finally(() => {
      pendingRequest = undefined;
    }));
}

export async function canShowNotifications(): Promise<boolean> {
  try {
    // Electron also requests authorization when it initializes its presenter.
    if (process.platform === "darwin" && (await notificationPermission()) !== "granted") return false;

    return Notification.isSupported();
  } catch {
    return false;
  }
}
