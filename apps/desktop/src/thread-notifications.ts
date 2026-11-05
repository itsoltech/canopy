import { BrowserWindow, ipcMain, Notification, type IpcMainInvokeEvent } from "electron";
import { Schema } from "effect";

const Notice = Schema.Struct({
  threadId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9~-]{1,100}$/)),
  event: Schema.Literals(["completed", "failed", "input"]),
  sound: Schema.Boolean,
});

/** Invoked only from an authorized application frame, and never accepts thread content. */
export function registerThreadNotifications(authorize: (event: IpcMainInvokeEvent) => void): void {
  ipcMain.handle("canopy:thread-notification", (event, raw: Schema.Codec.Encoded<typeof Notice>) => {
    authorize(event);
    const value = Schema.decodeUnknownSync(Notice)(raw);

    if (!Notification.isSupported()) return false;

    const body = {
      completed: "A thread finished.",
      failed: "A thread failed.",
      input: "A thread needs your input or approval.",
    }[value.event];

    const notification = new Notification({ title: "Canopy", body, silent: !value.sound });
    notification.on("click", () => {
      if (event.sender.isDestroyed()) return;
      const window = BrowserWindow.fromWebContents(event.sender);

      if (window?.isMinimized()) window.restore();
      window?.show();
      window?.focus();
      event.sender.send("canopy:thread-notification-click", value.threadId);
    });
    notification.show();

    return true;
  });
}
