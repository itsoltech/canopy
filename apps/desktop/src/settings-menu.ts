import type { BaseWindow, KeyboardEvent, MenuItem, MenuItemConstructorOptions } from "electron";

export function settingsMenu(openAppSettings: (keyboard: boolean) => void, changeDesktopMode: () => void) {
  return [
    {
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
      click: (
        _item: MenuItem | undefined,
        _window: BaseWindow | undefined,
        event: Pick<KeyboardEvent, "triggeredByAccelerator">,
      ) => openAppSettings(Boolean(event.triggeredByAccelerator)),
    },
    { label: "Change desktop mode…", click: changeDesktopMode },
  ] as const satisfies readonly MenuItemConstructorOptions[];
}
