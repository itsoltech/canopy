import { app, ipcMain, nativeTheme, type IpcMainInvokeEvent, type WebContents } from "electron";
import { Schema, Result } from "effect";
import { visualTheme, RateWindow } from "@canopy/domain/visuals";
import type { DesktopHtmlEvent } from "@canopy/ui/desktop";
import {
  ViewerInput,
  ViewerStart,
  ViewerCommand,
  ViewerId,
  ViewerRequest,
  ViewerResponse,
} from "./html-viewer-input.ts";
import { spawnViewer } from "./html-viewer-child.ts";
import { windowAppearance } from "./window-appearance.ts";

type OpenRequest = Exclude<typeof ViewerRequest.Type, { type: "command" }>;

function currentTheme() {
  const appearance = windowAppearance();

  const mode =
    appearance.scheme === "dark" || (appearance.scheme === "system" && nativeTheme.shouldUseDarkColors)
      ? "dark"
      : "light";

  return visualTheme(appearance[mode], mode);
}

/** Main owns routing and lifetime. A renderer can control only its own current stream. */
class ViewerLaunch {
  private readonly process = spawnViewer();
  readonly child = this.process.child;
  readonly cleaned = this.process.cleaned;
  private readonly rate = new RateWindow(240);
  private framePending = false;
  private ended = false;
  private opened = false;

  constructor(
    readonly owner: WebContents,
    readonly id: string | undefined,
  ) {
    owner.on("did-start-navigation", this.navigation);
    owner.once("destroyed", this.stop);
    owner.once("render-process-gone", this.stop);
  }

  private readonly navigation = (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame) this.stop();
  };

  readonly stop = () => {
    if (this.ended) return;
    this.ended = true;
    this.detach();
    this.child.kill("SIGKILL");
  };

  private detach() {
    this.owner.removeListener("did-start-navigation", this.navigation);
    this.owner.removeListener("destroyed", this.stop);
    this.owner.removeListener("render-process-gone", this.stop);
  }

  emit(event: Omit<DesktopHtmlEvent, "id"> | typeof ViewerResponse.Type) {
    if (this.ended || !this.id || this.owner.isDestroyed()) return;
    this.owner.send("canopy:agent-html-event", { ...event, id: this.id });
  }

  command(command: typeof ViewerCommand.Type) {
    if (this.ended || !this.opened || !this.id) return;

    if (command.type === "ack") {
      if (!this.framePending) return;
      this.framePending = false;
    }

    // Input floods must never consume ACK or lifecycle delivery slots.
    if (
      command.type === "input" &&
      (command.event.type === "mouseMove" || command.event.type === "mouseWheel") &&
      !this.rate.allow(Date.now())
    )
      return;
    this.child.send({ type: "command", command }, () => {});
  }

  start(input: OpenRequest) {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        fail();
        this.stop();
      }, 15000);

      const fail = () => {
        clearTimeout(timeout);
        reject(new Error("Couldn't open this visual."));
      };

      this.child.once("error", () => {
        fail();
        this.stop();
      });
      this.child.once("exit", () => {
        fail();

        if (!this.ended) this.emit({ type: "error", message: "This visual stopped responding." });
        this.ended = true;
        this.detach();
      });
      this.child.on("message", (raw) => {
        const decoded = Schema.decodeUnknownResult(ViewerResponse)(raw);

        if (Result.isFailure(decoded) || this.ended) return;
        const event = decoded.success;

        switch (event.type) {
          case "ready":
            this.child.send(input, () => {});

            return;
          case "opened":
            clearTimeout(timeout);
            this.opened = true;
            resolve();

            return;
          case "frame":
            if (this.framePending) return;
            this.framePending = true;
            break;
          case "error":
            this.emit(event);
            fail();
            this.stop();

            return;
        }

        this.emit(event);
      });
    });
  }
}

export function registerHtmlViewer(authorize: (event: IpcMainInvokeEvent) => void) {
  let viewer: ViewerLaunch | undefined;
  const profiles = new Set<Promise<void>>();

  const authorized = (event: IpcMainInvokeEvent) => {
    authorize(event);

    if (event.senderFrame !== event.sender.mainFrame) throw new Error("Untrusted desktop request");
  };

  const replace = (event: IpcMainInvokeEvent, input: OpenRequest) => {
    viewer?.emit({ type: "replaced" });
    viewer?.stop();
    const next = new ViewerLaunch(event.sender, input.type === "start" ? input.id : undefined);
    viewer = next;
    profiles.add(next.cleaned);
    void next.cleaned.then(() => profiles.delete(next.cleaned));

    return next.start(input);
  };

  app.on("before-quit", () => viewer?.stop());
  app.on("will-quit", (event) => {
    if (!profiles.size) return;
    event.preventDefault();
    viewer?.stop();
    viewer = undefined;
    // Let Electron finish canceling this quit before requesting the next one.
    void Promise.all(profiles).finally(() => setImmediate(() => app.quit()));
  });
  ipcMain.handle("canopy:agent-html-open", (event, specJson: string, title: string) => {
    authorized(event);
    const input = Schema.decodeUnknownSync(ViewerInput)({ specJson, title });

    return replace(event, { type: "open", ...input, theme: currentTheme() });
  });
  ipcMain.handle("canopy:agent-html-start", (event, raw: typeof ViewerStart.Type) => {
    authorized(event);
    const input = Schema.decodeUnknownSync(ViewerStart)(raw);

    return replace(event, { ...input, type: "start", theme: input.theme ?? currentTheme() });
  });
  ipcMain.handle("canopy:agent-html-command", (event, id: string, raw: typeof ViewerCommand.Type) => {
    authorized(event);
    const key = Schema.decodeUnknownSync(ViewerId)(id);
    const command = Schema.decodeUnknownSync(ViewerCommand)(raw);

    if (viewer?.owner === event.sender && viewer.id === key) viewer.command(command);
  });
  ipcMain.handle("canopy:agent-html-stop", (event, id: string) => {
    authorized(event);
    const key = Schema.decodeUnknownSync(ViewerId)(id);

    if (viewer?.owner === event.sender && viewer.id === key) viewer.stop();
  });
}
