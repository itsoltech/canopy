import { type BrowserWindow, ipcMain, session, protocol } from "electron";
import { randomBytes } from "node:crypto";
import { openShellEnvelope, VisualFrameInbox, type VisualTheme } from "@canopy/domain/visuals";
import { Schema, Result } from "effect";
import { compileViewer } from "./html-viewer-document.ts";
import { createViewerWindow, stopViewerFrames } from "./html-viewer-window.ts";

protocol.registerSchemesAsPrivileged([{ scheme: "canopy-agent-html", privileges: { standard: true, secure: true } }]);

const EnvelopeInput = Schema.String.check(Schema.isMaxLength(8448));

/** One viewer, one ephemeral session. No app-session cookies, storage, permissions or network. */
export function createHtmlViewer() {
  let viewer: BrowserWindow | undefined;
  let token = "";
  let lastResponse = 0;
  let inbox = new VisualFrameInbox(new Map(), true);
  let document = "";
  let documentUrl = "";
  const isolated = session.fromPartition("canopy-agent-html", { cache: false });

  const configured = isolated.setProxy({
    proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9",
    proxyBypassRules: "<-loopback>",
  });

  isolated.protocol.handle(
    "canopy-agent-html",
    (request) =>
      new Response(request.url === documentUrl ? document : "", {
        status: request.url === documentUrl ? 200 : 404,
        headers: { "Content-Type": "text/html; charset=utf-8", "X-DNS-Prefetch-Control": "off" },
      }),
  );
  isolated.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: details.url !== documentUrl && !/^(about:|data:|blob:)/.test(details.url) }),
  );
  isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.setDevicePermissionHandler(() => false);
  isolated.on("will-download", (download) => download.preventDefault());

  function release(target: BrowserWindow) {
    if (viewer !== target) return;
    viewer = undefined;
    token = "";
    document = "";
    documentUrl = "";
    void isolated.clearStorageData();
  }

  ipcMain.on("canopy:agent-html-message", (event, raw: string) => {
    if (!viewer || event.sender !== viewer.webContents || event.senderFrame !== event.sender.mainFrame) return;
    const bounded = Schema.decodeUnknownResult(EnvelopeInput)(raw);

    if (Result.isFailure(bounded)) return;
    const message = openShellEnvelope(bounded.success, token);
    const parsed = message !== undefined && inbox.receive(message, Date.now());

    if (parsed) lastResponse = Date.now();

    if (parsed && parsed.type === "escape") viewer.close();
  });

  return async (specJson: string, title: string, theme: VisualTheme) => {
    await configured;
    const mounted = await compileViewer(specJson, title, theme);

    if (mounted.kind !== "ready") throw new Error("Couldn't open this visual.");

    if (viewer) viewer.destroy();
    token = mounted.token;
    inbox = new VisualFrameInbox(new Map(), true);
    lastResponse = Date.now();

    const target = createViewerWindow(isolated);

    viewer = target;

    const watchdog = setInterval(() => {
      if (!target.isDestroyed() && Date.now() - lastResponse > 10000) {
        clearInterval(watchdog);
        stopViewerFrames(target);
        const stopped = createViewerWindow(isolated);
        viewer = stopped;
        token = "";
        document =
          '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><p>This visual stopped responding.</p>';
        documentUrl = `canopy-agent-html://viewer/${randomBytes(18).toString("hex")}`;
        stopped.on("closed", () => release(stopped));
        target.destroy();
        void stopped.loadURL(documentUrl).catch(() => {});
      }
    }, 1000);

    target.on("closed", () => {
      clearInterval(watchdog);
      release(target);
    });
    // A hostile loop can keep load pending forever. Main's watchdog owns its lifetime.
    document = mounted.html;
    documentUrl = `canopy-agent-html://viewer/${randomBytes(18).toString("hex")}`;
    void target.loadURL(documentUrl).catch(() => {});
  };
}
