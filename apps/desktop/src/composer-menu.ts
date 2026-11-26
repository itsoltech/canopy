import type { BrowserWindow, ContextMenuParams, Menu, WebContents, WebFrameMain } from "electron";
import type { DesktopComposerMenu, DesktopComposerMenuResponse } from "@canopy/ui/desktop";

// The native edit commands target Chromium's focused editor, including its clipboard events and undo stack.
const editCommands = new Map<string, { shortcut: string; run: (contents: WebContents) => void }>([
  ["undo", { shortcut: "Mod+Z", run: (contents) => contents.undo() }],
  ["redo", { shortcut: process.platform === "win32" ? "Mod+Y" : "Mod+Shift+Z", run: (contents) => contents.redo() }],
  ["cut", { shortcut: "Mod+X", run: (contents) => contents.cut() }],
  ["copy", { shortcut: "Mod+C", run: (contents) => contents.copy() }],
  ["paste", { shortcut: "Mod+V", run: (contents) => contents.paste() }],
  ["selectall", { shortcut: "Mod+A", run: (contents) => contents.selectAll() }],
]);

function hasWebOrigin(frame: WebFrameMain, origin: string | undefined) {
  try {
    return new URL(frame.url).origin === origin;
  } catch {
    return false;
  }
}

interface PendingMenu {
  id: number;
  frame: WebFrameMain;
  menu: Menu;
  timeout: ReturnType<typeof setTimeout>;
  shown: boolean;
}

export function attachComposerMenu(target: BrowserWindow, webUrl: () => string | undefined) {
  const contents = target.webContents;
  let pending: PendingMenu | undefined;
  let nextId = 0;

  function clear() {
    clearTimeout(pending?.timeout);
    pending = undefined;
  }

  function fallback(request: PendingMenu) {
    clear();

    if (request.frame === contents.mainFrame) request.menu.popup({ window: target });
  }

  contents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) clear();
  });
  contents.once("destroyed", clear);
  target.on("blur", clear);

  contents.ipc.handle("canopy:composer-menu-response", (event, id: number, response: DesktopComposerMenuResponse) => {
    const request = pending;
    const frame = event.senderFrame;

    if (
      !request ||
      id !== request.id ||
      frame !== request.frame ||
      frame !== contents.mainFrame ||
      !hasWebOrigin(frame, webUrl())
    )
      return false;

    if (response === "native") {
      if (request.shown) return false;
      fallback(request);

      return true;
    }

    if (!target.isFocused()) return false;

    if (response === "show") {
      if (request.shown) return false;
      clearTimeout(request.timeout);
      request.shown = true;

      return true;
    }

    if (!request.shown) return false;
    clear();

    if (response === "dismiss") return true;

    if (!Number.isSafeInteger(response)) return false;
    const item = request.menu.items[response];

    if (!item?.enabled || item.type === "separator") return false;
    const edit = editCommands.get(item.role?.toLowerCase() ?? "");

    if (edit) edit.run(contents);
    else item.click({}, target, contents);

    return true;
  });

  return (params: ContextMenuParams, menu: Menu) => {
    clear();
    const frame = params.frame;

    if (!params.isEditable || !frame || frame !== contents.mainFrame || !hasWebOrigin(frame, webUrl())) return false;

    const id = ++nextId;

    const timeout = setTimeout(() => {
      if (pending?.id === id) fallback(pending);
    }, 250);

    pending = { id, frame, menu, timeout, shown: false };

    const offer: DesktopComposerMenu = {
      id,
      keyboard: params.menuSourceType === "keyboard",
      items: menu.items.map((item) =>
        item.type === "separator"
          ? null
          : {
              label: item.label,
              enabled: item.enabled,
              shortcut: editCommands.get(item.role?.toLowerCase() ?? "")?.shortcut,
            },
      ),
    };

    contents.send("canopy:composer-menu", offer);

    return true;
  };
}
