import { app, BrowserWindow, screen, session, type Display, type Rectangle } from "electron";
import { join } from "node:path";
import type { ActivityNotchDisplay, ActivityNotchPlacement } from "@canopy/ui/desktop";
import { activityNotchFrame } from "./activity-notch-frame.ts";
import {
  activityNotchEarWidth,
  activityNotchGeometry,
  type ActivityNotchCutout,
  type ActivityNotchLayout,
  type ActivityNotchRect,
} from "./activity-notch-geometry.ts";
import { activityNotchPage } from "./activity-notch-page.ts";

interface MacNotchDisplay {
  primaryCutout(): ActivityNotchCutout | undefined;
}

let macDisplay: MacNotchDisplay | null | undefined;

export function loadMacActivityNotchDisplay() {
  const directory = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build");

  // SAFETY: Both paths load the Canopy N-API addon, which exports primaryCutout with this contract.
  return require(join(directory, "native/activity-notch-display.node")) as MacNotchDisplay;
}

function primaryActivityNotchMenuBand() {
  if (process.platform !== "darwin" || macDisplay === null) return undefined;

  try {
    macDisplay ??= loadMacActivityNotchDisplay();

    return { cutout: macDisplay.primaryCutout() };
  } catch {
    // Keep the simulated shape in the work area when the camera's position is unknown.
    macDisplay = null;

    return undefined;
  }
}

function sameBounds(left: Rectangle, right: Rectangle) {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

type Position = Omit<ActivityNotchLayout, "revision" | "moving">;

const body = (bounds: Rectangle): ActivityNotchRect => ({
  x: bounds.x + activityNotchEarWidth,
  y: bounds.y,
  width: bounds.width - 2 * activityNotchEarWidth,
  height: bounds.height,
});

const relative = (rect: ActivityNotchRect, origin: Rectangle): ActivityNotchRect => ({
  ...rect,
  x: rect.x - origin.x,
  y: rect.y - origin.y,
});

/** Connected displays for Settings, the main one first. */
export function activityNotchDisplays(): ActivityNotchDisplay[] {
  const main = screen.getPrimaryDisplay().id;

  return screen
    .getAllDisplays()
    .map(({ id, label, size }) => ({ id, label: label.trim(), width: size.width, height: size.height, main: id === main }))
    .toSorted((left, right) => Number(right.main) - Number(left.main));
}

/** The display an edge tab or a pill was dropped on, while it is connected; otherwise the main display. */
export function activityNotchDisplay(placement: ActivityNotchPlacement): Display {
  const id = placement.mode === "notch" ? undefined : placement.display;

  return screen.getAllDisplays().find((display) => display.id === id) ?? screen.getPrimaryDisplay();
}

/**
 * The native window keeps the open panel's horizontal extent and only changes its height.
 * Moving its left edge would show the notch off center until the renderer repositions it.
 */
function windowBounds(display: Display, menuBand: ReturnType<typeof primaryActivityNotchMenuBand>) {
  const open = activityNotchGeometry(display, 1, menuBand).bounds;

  return (layout: Rectangle): Rectangle => ({ ...layout, x: open.x, width: open.width });
}

function notchPosition(
  target: BrowserWindow,
  expandedRows: number,
  reservedRows: number,
  previousHeight?: number,
): Position {
  const display = screen.getPrimaryDisplay();
  const menuBand = primaryActivityNotchMenuBand();
  const compact = activityNotchGeometry(display, 0, menuBand).bounds;
  const frame = windowBounds(display, menuBand);
  const original = target.getBounds();
  let nativeCompactHeight = process.platform === "win32" ? previousHeight : undefined;

  const position = (window: Rectangle, rows: number, height?: number): Position => {
    const shape = activityNotchGeometry(display, rows, menuBand, height);
    const opened = body(activityNotchGeometry(display, Math.max(rows, 1), menuBand, height).bounds);

    return {
      side: "top",
      header: "start",
      draggable: false,
      expanded: rows > 0,
      headerHeight: shape.headerHeight,
      shape: relative(body(shape.bounds), window),
      tab: relative(body({ ...compact, height: shape.headerHeight }), window),
      list: relative(
        { ...opened, y: opened.y + shape.headerHeight, height: opened.height - shape.headerHeight },
        window,
      ),
    };
  };

  if (process.platform === "win32" && (!reservedRows || nativeCompactHeight === undefined)) {
    const requested = frame(compact);

    // Win32 can enforce a taller minimum window. Always request the nominal
    // compact height when measuring, so repeated collapse never grows the notch.
    if (!sameBounds(original, { ...requested, height: nativeCompactHeight ?? compact.height }))
      target.setBounds(requested);

    const current = target.getBounds();
    nativeCompactHeight = current.height;

    if (!reservedRows) return position(current, 0, current.height);
  }

  const reserved = frame(activityNotchGeometry(display, reservedRows, menuBand, nativeCompactHeight).bounds);

  if (!sameBounds(original, reserved)) target.setBounds(reserved);

  return position(reserved, expandedRows, nativeCompactHeight);
}

/** Sizes the native window for the reserved rows and returns where the renderer draws the rows on show. */
export function positionActivityNotchWindow(
  target: BrowserWindow,
  placement: ActivityNotchPlacement,
  rows: { expanded: number; reserved: number; previousHeight?: number | undefined; dragging?: boolean },
): Position {
  if (placement.mode === "notch") return notchPosition(target, rows.expanded, rows.reserved, rows.previousHeight);

  const frame = activityNotchFrame(
    activityNotchDisplay(placement).workArea,
    placement,
    rows.expanded,
    rows.reserved,
    rows.dragging,
  );

  if (!sameBounds(target.getBounds(), frame.window)) target.setBounds(frame.window);

  return {
    side: frame.side,
    header: frame.header,
    draggable: true,
    expanded: rows.expanded > 0,
    headerHeight: frame.headerHeight,
    shape: relative(frame.shape, frame.window),
    tab: relative(frame.tab, frame.window),
    list: relative(frame.list, frame.window),
  };
}

/** The compact tab in screen coordinates, where a drag starts from. */
export function activityNotchTab(placement: ActivityNotchPlacement): ActivityNotchRect | undefined {
  if (placement.mode === "notch") return undefined;

  return activityNotchFrame(activityNotchDisplay(placement).workArea, placement, 0, 0, true).tab;
}

/** The window is wider than the compact notch, so only the outline itself takes the pointer. */
export function setActivityNotchInteractive(target: BrowserWindow, interactive: boolean) {
  target.setIgnoreMouseEvents(!interactive, { forward: true });
}

export function createActivityNotchWindow(placement: ActivityNotchPlacement) {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(activityNotchPage())}`;
  const isolated = session.fromPartition("canopy-activity-notch");
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) =>
    callback({ cancel: details.resourceType !== "mainFrame" || details.url !== url }),
  );

  const display = screen.getPrimaryDisplay();
  const menuBand = primaryActivityNotchMenuBand();

  const bounds =
    placement.mode === "notch"
      ? windowBounds(display, menuBand)(activityNotchGeometry(display, 0, menuBand).bounds)
      : activityNotchFrame(activityNotchDisplay(placement).workArea, placement, 0, 0).window;

  const target = new BrowserWindow({
    ...bounds,
    title: "Canopy activity",
    frame: false,
    roundedCorners: false,
    transparent: true,
    hasShadow: false,
    show: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Electron bypasses AppKit’s visible-frame clamp for a frameless window with this option.
    ...(process.platform === "darwin" && {
      type: "panel" as const,
      acceptFirstMouse: true,
      enableLargerThanScreen: true,
    }),
    webPreferences: {
      session: isolated,
      preload: join(app.getAppPath(), "dist/activity-notch-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  target.removeMenu();
  setActivityNotchInteractive(target, false);

  if (process.platform === "darwin") {
    target.excludedFromShownWindowsMenu = true;

    if (macDisplay) target.setAlwaysOnTop(true, "status");
  }

  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  target.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  target.webContents.on("will-redirect", (event) => event.preventDefault());
  target.webContents.on("will-attach-webview", (event) => event.preventDefault());

  return { target, load: () => target.loadURL(url) };
}
