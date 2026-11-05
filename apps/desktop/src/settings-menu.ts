import type { MenuItemConstructorOptions } from "electron";

export function settingsMenu(openAppSettings: () => void, changeDesktopMode: () => void) {
  return [
    { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openAppSettings },
    { label: "Change desktop mode…", click: changeDesktopMode },
  ] satisfies MenuItemConstructorOptions[];
}
