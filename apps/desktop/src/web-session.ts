import { randomBytes } from "node:crypto";
import type { Session, WebContents } from "electron";

export const DESKTOP_SESSION_HEADER = "x-canopy-desktop-session";

/** A launch-only capability shared with the controller over private stdin, never with the renderer. */
export class DesktopWebSession {
  private active = true;

  constructor(
    private readonly origin: () => string,
    readonly token = randomBytes(32).toString("hex"),
  ) {}

  headers(url: string): Record<string, string> {
    if (!this.active) throw new Error("Desktop services stopped. Restart Canopy.");

    return new URL(url).origin === this.origin() ? { [DESKTOP_SESSION_HEADER]: this.token } : {};
  }

  /** A stopped controller releases its port: never send credentials to a process that takes it over. */
  revoke(contents: (WebContents | undefined)[]) {
    this.active = false;

    for (const content of contents) if (content && !content.isDestroyed()) content.stop();
  }

  attach(session: Session, contents: () => (WebContents | undefined)[]) {
    // Run on redirects and external destinations too: a private header must never leave the BFF origin.
    session.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
      const headers = { ...details.requestHeaders };

      for (const name of Object.keys(headers)) if (name.toLowerCase() === DESKTOP_SESSION_HEADER) delete headers[name];
      const local = new URL(details.url).origin === this.origin();

      const own = contents().some(
        (content) => content && !content.isDestroyed() && content.id === details.webContentsId,
      );

      const frame = details.frame;

      const trusted =
        own &&
        (details.resourceType === "mainFrame" ||
          (frame &&
            !frame.parent &&
            new URL(frame.url).origin === this.origin() &&
            (!details.initiatorOrigin || details.initiatorOrigin === this.origin())));

      if (local && (!this.active || !trusted)) {
        callback({ cancel: true });

        return;
      }

      if (local) headers[DESKTOP_SESSION_HEADER] = this.token;
      callback({ requestHeaders: headers });
    });
  }
}
