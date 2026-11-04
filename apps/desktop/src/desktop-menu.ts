import { app, BrowserWindow, Menu, shell, type Tray } from "electron";
import type { DesktopStatus } from "@canopy/ui/desktop";
import type { DesktopUpdates } from "./updates.ts";
import type { QuitGuard } from "./quit-guard.ts";
import type { quitKeyEvent } from "./quit-key-event.ts";
import { windowViewMenu } from "./window-chrome.ts";

interface MenuOptions {
  status: DesktopStatus;
  tray: Tray | undefined;
  productName: string;
  showMain: () => void;
  openSettings: () => void;
  updates: DesktopUpdates;
  quitGuard: QuitGuard;
  quitKey: ReturnType<typeof quitKeyEvent>;
  logsDirectory: string;
}

export function updateDesktopMenus(options: MenuOptions) {
  const { status, tray, productName, showMain, openSettings, updates, quitGuard, quitKey, logsDirectory } = options;

  const text =
    status.phase === "error"
      ? "Needs attention"
      : status.worker === "online"
        ? "Worker online"
        : status.phase === "starting"
          ? "Starting…"
          : "Worker offline";

  tray?.setToolTip(`${productName} · ${text}`);
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${productName} · ${text}`, enabled: false },
      { label: `Open ${productName}`, click: showMain },
      {
        label: `CLIs: ${
          Object.entries(status.clis)
            .filter(([, found]) => found)
            .map(([name]) => name)
            .join(", ") || "none found"
        }`,
        enabled: false,
      },
      { label: "Desktop settings…", click: openSettings },
      updates.item(),
      { type: "separator" },
      { label: `Quit ${productName}`, click: () => app.quit() },
    ]),
  );

  const quitItem: Electron.MenuItemConstructorOptions = {
    label: `Quit ${productName}`,
    accelerator: "CmdOrCtrl+Q",
    click: (_item, _target, event) => {
      if (event.triggeredByAccelerator) {
        const repeat = quitKey.isRepeat();

        if (!BrowserWindow.getFocusedWindow() && quitGuard.mode !== "immediately") showMain();
        quitGuard.accelerator(BrowserWindow.getFocusedWindow(), repeat);
      } else app.quit();
    },
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: productName,
      submenu: [
        ...(process.platform === "darwin" ? [{ role: "about" as const }, { type: "separator" as const }] : []),
        { label: "Desktop settings…", accelerator: "CmdOrCtrl+,", click: openSettings },
        updates.item(),
        { label: "Open logs folder", click: () => void shell.openPath(logsDirectory) },
        ...(process.platform === "darwin"
          ? [
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
            ]
          : []),
        { type: "separator" },
        quitItem,
      ],
    },
    { role: "editMenu" },
    windowViewMenu(),
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
