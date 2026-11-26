import { clipboard, Menu, shell, type BrowserWindow } from "electron";
import { ComposerMenu } from "./composer-menu.ts";
import { contextMenuTemplate } from "./context-menu-template.ts";

export function attachContextMenu(
  target: BrowserWindow,
  internalOrigins: () => (string | undefined)[],
  webUrl: () => string | undefined,
) {
  const contents = target.webContents;
  const composerMenu = new ComposerMenu(target, webUrl);

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
      internalOrigins(),
    );

    if (!template.length) return;
    const menu = Menu.buildFromTemplate(template);

    if (!composerMenu.offer(params, menu)) menu.popup({ window: target });
  });
}
