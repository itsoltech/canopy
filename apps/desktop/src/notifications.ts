import { BrowserWindow, ipcMain, Notification, type IpcMainInvokeEvent } from "electron";
import { Schema } from "effect";

const Notice = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[a-z]+:[a-zA-Z0-9~:-]{1,200}$/)),
  title: Schema.String.check(Schema.isMaxLength(200)),
  body: Schema.String.check(Schema.isMaxLength(600)),
  // Only a thread or a bot chat: a notification never navigates anywhere else.
  path: Schema.String.check(Schema.isPattern(/^\/(?:threads|bots)\/[a-zA-Z0-9~-]{1,100}$/)),
  sound: Schema.Boolean,
});

/** Keys already shown, so windows of different origins (or a reloaded one) show each event once. */
const KEEP_MS = 30 * 60_000;
const shown = new Map<string, number>();

function firstTime(key: string, now: number): boolean {
  for (const [old, at] of shown) if (now - at >= KEEP_MS) shown.delete(old);

  if (shown.has(key)) return false;
  shown.set(key, now);

  return true;
}

/**
 * Invoked only from an authorized application frame. The renderer sends short plain-text previews
 * (noticePreview: no markdown or credentials); the click focuses that window and sends the path back.
 */
export function registerNotifications(authorize: (event: IpcMainInvokeEvent) => void, iconPath: string): void {
  ipcMain.handle("canopy:notification", (event, raw: Schema.Codec.Encoded<typeof Notice>) => {
    authorize(event);
    const value = Schema.decodeUnknownSync(Notice)(raw);

    if (!Notification.isSupported() || !firstTime(value.key, Date.now())) return false;

    const notification = new Notification({
      title: value.title,
      body: value.body,
      silent: !value.sound,
      // Linux shows this icon; macOS always uses the app's own.
      ...(process.platform === "linux" && { icon: iconPath }),
    });

    notification.on("click", () => {
      if (event.sender.isDestroyed()) return;
      const window = BrowserWindow.fromWebContents(event.sender);

      if (window?.isMinimized()) window.restore();
      window?.show();
      window?.focus();
      event.sender.send("canopy:notification-click", value.path);
    });
    notification.show();

    return true;
  });
}
