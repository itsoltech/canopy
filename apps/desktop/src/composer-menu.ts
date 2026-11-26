import {
  app,
  session,
  WebContentsView,
  type BrowserWindow,
  type ContextMenuParams,
  type Menu,
  type MenuItem,
  type Rectangle,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { join } from "node:path";
import { windowColors } from "./window-appearance.ts";
import {
  composerMenuUrl,
  menuFrameHeight,
  menuRowHeight,
  menuSeparatorHeight,
  type ComposerMenuPage,
  type EditShortcut,
} from "./composer-menu-page.ts";

// WebContents edit commands retain Chromium's native clipboard events and undo stack.
const editCommands = new Map<string, { shortcut: EditShortcut; run: (contents: WebContents) => void }>([
  ["undo", { shortcut: { key: "Z" }, run: (contents) => contents.undo() }],
  [
    "redo",
    {
      shortcut: process.platform === "win32" ? { key: "Y" } : { key: "Z", shift: true },
      run: (contents) => contents.redo(),
    },
  ],
  ["cut", { shortcut: { key: "X" }, run: (contents) => contents.cut() }],
  ["copy", { shortcut: { key: "C" }, run: (contents) => contents.copy() }],
  ["paste", { shortcut: { key: "V" }, run: (contents) => contents.paste() }],
  ["selectall", { shortcut: { key: "A" }, run: (contents) => contents.selectAll() }],
]);

function hasWebOrigin(frame: WebFrameMain, origin: string | undefined) {
  try {
    return new URL(frame.url).origin === origin;
  } catch {
    return false;
  }
}

function menuBounds(window: Rectangle, point: { x: number; y: number }, items: MenuItem[]): Rectangle {
  const width = Math.min(216, window.width);

  const naturalHeight = items.reduce(
    (height, item) => height + (item.type === "separator" ? menuSeparatorHeight : menuRowHeight),
    menuFrameHeight,
  );

  const height = Math.min(naturalHeight, window.height);
  const top = point.y + height > window.height && point.y >= height ? point.y - height : point.y;

  return {
    x: Math.max(0, Math.min(window.width - width, point.x)),
    y: Math.max(0, Math.min(window.height - height, top)),
    width,
    height,
  };
}

function createView() {
  const isolated = session.fromPartition("canopy-composer-menu");
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const view = new WebContentsView({
    webPreferences: {
      session: isolated,
      preload: join(app.getAppPath(), "dist/composer-menu-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  view.setBackgroundColor("#00000000");
  view.setBorderRadius(12);
  view.setVisible(false);
  const contents = view.webContents;
  contents.setIgnoreMenuShortcuts(true);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-frame-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());

  return view;
}

interface PendingMenu {
  id: number;
  frame: WebFrameMain;
  menu: Menu;
  point: { x: number; y: number };
  phase: "probe" | "render" | "open" | "focus";
  timeout?: ReturnType<typeof setTimeout> | undefined;
  item?: MenuItem | undefined;
}

export class ComposerMenu {
  private readonly contents: WebContents;
  private pending?: PendingMenu | undefined;
  private overlay?: { view: WebContentsView; ready: Promise<void> } | undefined;
  private nextId = 0;

  constructor(
    private readonly target: BrowserWindow,
    private readonly webUrl: () => string | undefined,
  ) {
    const contents = (this.contents = target.webContents);

    contents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) this.clear();
    });
    contents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseDown" || mouse.type === "mouseWheel") this.clear();
    });
    contents.on("before-input-event", (_event, key) => {
      if (key.type === "keyDown") this.clear();
    });
    target.on("blur", () => this.clear());
    target.on("resize", () => this.clear());
    target.once("closed", () => {
      clearTimeout(this.pending?.timeout);
      const view = this.overlay?.view.webContents;

      if (view && !view.isDestroyed()) view.close();
    });

    contents.ipc.on("canopy:composer-menu-probed", (event, id: number, accepted: boolean) => {
      const request = this.request(id, "probe");

      if (!request || event.senderFrame !== request.frame) return;

      if (accepted === true) void this.render(request);
      else this.fallback(request);
    });
    contents.ipc.on("canopy:composer-menu-focused", (event, id: number, focused: boolean) => {
      const request = this.request(id, "focus");

      if (!request || event.senderFrame !== request.frame) return;
      this.clear();

      if (focused !== true || !this.target.isFocused() || !request.item) return;
      const edit = editCommands.get(request.item.role?.toLowerCase() ?? "");

      if (edit) edit.run(this.contents);
      else request.item.click({}, this.target, this.contents);
    });
  }

  offer(params: ContextMenuParams, menu: Menu) {
    this.clear();
    const frame = params.frame;

    if (!params.isEditable || !frame || frame !== this.contents.mainFrame || !hasWebOrigin(frame, this.webUrl()))
      return false;
    const id = ++this.nextId;
    const request: PendingMenu = { id, frame, menu, point: { x: params.x, y: params.y }, phase: "probe" };
    request.timeout = setTimeout(() => this.fallback(request), 500);
    this.pending = request;
    frame.send("canopy:composer-menu-probe", id);

    return true;
  }

  private clear() {
    clearTimeout(this.pending?.timeout);
    this.pending = undefined;
    this.overlay?.view.setVisible(false);
  }

  private request(id: number, phase: PendingMenu["phase"]) {
    const request = this.pending;

    if (
      request?.id === id &&
      request.phase === phase &&
      request.frame === this.contents.mainFrame &&
      hasWebOrigin(request.frame, this.webUrl())
    )
      return request;

    return undefined;
  }

  private fallback(request: PendingMenu) {
    if (this.pending !== request) return;
    this.clear();

    if (request.frame === this.contents.mainFrame) request.menu.popup({ window: this.target });
  }

  private async render(request: PendingMenu) {
    request.phase = "render";

    try {
      const { view, ready } = (this.overlay ??= this.createOverlay());
      await ready;

      if (!this.request(request.id, "render")) return;
      view.setBounds(menuBounds(this.target.getContentBounds(), request.point, request.menu.items));
      const { surface, ink, muted, border, hover, accent } = windowColors();

      const page: ComposerMenuPage = {
        id: request.id,
        colors: { surface, ink, muted, border, hover, accent },
        items: request.menu.items.map((item) =>
          item.type === "separator"
            ? null
            : {
                label: item.label,
                enabled: item.enabled,
                shortcut: editCommands.get(item.role?.toLowerCase() ?? "")?.shortcut,
              },
        ),
      };

      view.webContents.send("canopy:composer-menu-render", page);
    } catch {
      this.fallback(request);
    }
  }

  private createOverlay() {
    const view = createView();
    this.target.contentView.addChildView(view);
    const contents = view.webContents;

    contents.on("render-process-gone", () => {
      if (this.overlay?.view !== view) return;
      this.overlay = undefined;
      this.target.contentView.removeChildView(view);
      contents.close();
      const request = this.pending;

      if (request?.phase === "render" || request?.phase === "open") this.fallback(request);
    });

    // Only the bundled, isolated menu can choose an action. The composer preload can only locate and refocus the field.
    contents.ipc.on("canopy:composer-menu-rendered", (event, id: number) => {
      const request = this.request(id, "render");

      if (!request || this.overlay?.view !== view || event.senderFrame !== contents.mainFrame) return;

      if (!this.target.isFocused()) return this.fallback(request);
      clearTimeout(request.timeout);
      request.phase = "open";
      view.setVisible(true);
      contents.focus();
    });

    contents.ipc.on("canopy:composer-menu-choice", (event, id: number, index: number | null) => {
      if (this.overlay?.view !== view || event.senderFrame !== contents.mainFrame || !contents.isFocused()) return;
      const request = this.request(id, "open");

      if (request) this.choose(request, index);
    });

    return { view, ready: contents.loadURL(composerMenuUrl) };
  }

  private choose(request: PendingMenu, index: number | null) {
    if (index !== null) {
      if (!Number.isSafeInteger(index)) return;
      const item = request.menu.items[index];

      if (!item?.enabled || item.type === "separator") return;
      request.item = item;
    }

    request.phase = "focus";
    request.timeout = setTimeout(() => {
      if (this.pending === request) this.clear();
    }, 500);
    this.overlay?.view.setVisible(false);
    this.contents.focus();
    request.frame.send("canopy:composer-menu-focus", request.id);
  }
}
