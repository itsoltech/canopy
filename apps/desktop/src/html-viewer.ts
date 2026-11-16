import { type BrowserWindow, ipcMain, protocol } from "electron";
import { randomBytes } from "node:crypto";
import { openShellEnvelope, shellEnvelope, VisualFrameInbox, type VisualTheme } from "@canopy/domain/visuals";
import type { DesktopHtmlCommand, DesktopHtmlHostMessage } from "@canopy/ui/desktop";
import { Schema, Result } from "effect";
import { compileViewer } from "./html-viewer-document.ts";
import { createViewerWindow, stopViewerFrames } from "./html-viewer-window.ts";
import { viewerSession } from "./html-viewer-session.ts";
import { streamViewer } from "./html-viewer-stream.ts";

protocol.registerSchemesAsPrivileged([{ scheme: "canopy-agent-html", privileges: { standard: true, secure: true } }]);

const EnvelopeInput = Schema.String.check(Schema.isMaxLength(8448));

/** One viewer, one ephemeral session. No app-session cookies, storage, permissions or network. */
export class HtmlViewer {
  private viewer: BrowserWindow | undefined;
  private token = "";
  private lastResponse = 0;
  private inbox = new VisualFrameInbox(new Map(), true);
  private document = { url: "", html: "" };
  private readonly session = viewerSession(() => this.document);
  private stream: ((command: DesktopHtmlCommand) => void) | undefined;
  private inline = false;
  private ready = false;
  private readonly pending = new Map<DesktopHtmlHostMessage["type"], DesktopHtmlHostMessage>();

  constructor() {
    ipcMain.on("canopy:agent-html-message", (event, raw: string) => {
      if (!this.viewer || event.sender !== this.viewer.webContents || event.senderFrame !== event.sender.mainFrame)
        return;
      const bounded = Schema.decodeUnknownResult(EnvelopeInput)(raw);

      if (Result.isFailure(bounded)) return;
      const message = openShellEnvelope(bounded.success, this.token);
      const parsed = message !== undefined && this.inbox.receive(message, Date.now());

      if (!parsed) return;
      this.lastResponse = Date.now();

      if (parsed.type === "ready") {
        this.ready = true;

        for (const pending of this.pending.values()) this.host(pending);
        this.pending.clear();
      }

      if (parsed.type === "escape") {
        if (this.inline) process.send?.({ type: "escape" });
        else this.viewer.close();
      }

      if (this.inline && (parsed.type === "height" || parsed.type === "ready"))
        process.send?.({ type: "height", height: Math.round(parsed.height) });

      if (this.inline && parsed.type === "render_error") this.fail("This visual couldn't be rendered.");
    });
  }

  async open(specJson: string, title: string, theme: VisualTheme, inline?: { width: number; height: number }) {
    await this.session.configured;
    const mounted = await compileViewer(specJson, title, theme);

    if (mounted.kind !== "ready") throw new Error("Couldn't open this visual.");
    this.token = mounted.token;
    this.lastResponse = Date.now();
    this.inline = Boolean(inline);
    const target = createViewerWindow(this.session.isolated, inline);
    this.viewer = target;

    if (inline) this.stream = streamViewer(target, (message) => this.fail(message));

    const watchdog = setInterval(() => {
      if (!target.isDestroyed() && Date.now() - this.lastResponse > 10000) this.fail("This visual stopped responding.");
    }, 1000);

    target.webContents.on("render-process-gone", () => {
      if (this.viewer === target) this.fail("This visual stopped responding.");
    });
    target.once("closed", () => {
      clearInterval(watchdog);

      if (this.viewer !== target) return;
      this.viewer = undefined;
      this.token = "";
      this.document = { url: "", html: "" };
      void this.session.isolated.clearStorageData();
    });
    this.load(target, mounted.html);
  }

  command(command: DesktopHtmlCommand) {
    if (!this.inline || !this.viewer || this.viewer.isDestroyed()) return;
    this.stream?.(command);

    if (command.type === "host") {
      if (this.ready) this.host(command.message);
      else this.pending.set(command.message.type, command.message);
    }
  }

  private host(message: DesktopHtmlHostMessage) {
    this.viewer?.webContents.send("canopy:agent-html-host", shellEnvelope(this.token, message));
  }

  private load(target: BrowserWindow, html: string) {
    this.document = { html, url: `canopy-agent-html://viewer/${randomBytes(18).toString("hex")}` };
    // A hostile loop can keep load pending forever. The browser-process watchdog owns its lifetime.
    void target.loadURL(this.document.url).catch(() => {});
  }

  private fail(message: string) {
    const target = this.viewer;

    if (!target || target.isDestroyed()) return;
    this.viewer = undefined;
    this.stream = undefined;
    this.token = "";
    stopViewerFrames(target);

    if (this.inline) {
      process.send?.({ type: "error", message });
      target.destroy();

      return;
    }

    const stopped = createViewerWindow(this.session.isolated);
    this.viewer = stopped;
    target.destroy();
    this.load(
      stopped,
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><p>This visual stopped responding.</p>',
    );
  }
}
