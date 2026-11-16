import type { BrowserWindow, WebContents } from "electron";

function isDestroyedObjectError(error: Error): boolean {
  return error instanceof Error && error.message.includes("Object has been destroyed");
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
  if (!target || target.isDestroyed()) return;
  sendWebContentsMessage(target.webContents, send);
}
