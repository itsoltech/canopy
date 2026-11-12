import { clipboard, Menu, shell, type BrowserWindow } from "electron";
import { contextMenuTemplate } from "./context-menu-template.ts";

export function attachContextMenu(target: BrowserWindow) {
  const contents = target.webContents;

  // Chromium emits this only for contextmenu events the renderer has not cancelled.
  // Sidebar/bot menus and sensitive values keep their existing preventDefault behavior.
  contents.on("context-menu", (_event, params) => {
    const template = contextMenuTemplate(
      params,
      {
        copyLink: (url) => clipboard.writeText(url),
        openExternal: (url) => void shell.openExternal(url).catch(() => {}),
        replaceMisspelling: (word) => contents.replaceMisspelling(word),
      },
      contents.session.isSpellCheckerEnabled(),
    );

    if (template.length) Menu.buildFromTemplate(template).popup({ window: target });
  });
}
