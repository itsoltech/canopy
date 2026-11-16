import type { BrowserWindow, WebContents } from "electron";

function isDestroyedObjectError(error: Error): boolean {
  return error instanceof Error && error.message.includes("Object has been destroyed");
}

/** A BrowserWindow can outlive its native object; optional chaining alone is not a liveness check. */
export function windowContents(target: BrowserWindow | undefined): WebContents | undefined {
  if (!target || target.isDestroyed()) return undefined;

  const contents = target.webContents;

  return contents.isDestroyed() ? undefined : contents;
}

/** Electron can destroy WebContents between the liveness check and send(). */
export function sendWebContentsMessage(target: WebContents | undefined, send: (target: WebContents) => void): void {
  if (!target || target.isDestroyed()) return;

  try {
    send(target);
  } catch (error) {
    if (!(error instanceof Error) || !isDestroyedObjectError(error)) throw error;
  }
}

export function sendWindowsMessage(
  targets: readonly (BrowserWindow | undefined)[],
  send: (target: WebContents) => void,
): void {
  for (const target of targets) sendWindowMessage(target, send);
}

export function sendWindowMessage(target: BrowserWindow | undefined, send: (target: WebContents) => void): void {
  sendWebContentsMessage(windowContents(target), send);
}
