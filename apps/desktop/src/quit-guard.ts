import type { BrowserWindow } from "electron";
import { QuitMachine, type QuitMachineOptions } from "./quit-machine.ts";

/** Only keyboard requests enter the guard; app.quit() remains an unconditional lifecycle operation. */
export class QuitGuard extends QuitMachine {
  constructor(
    mode: QuitMachine["mode"],
    options: QuitMachineOptions,
    private readonly platform: string,
  ) {
    super(mode, options);
  }

  accelerator(focused: BrowserWindow | null, isRepeat: boolean | undefined) {
    if (this.mode === "immediately") {
      this.press(false);

      return;
    }

    if (!focused || isRepeat === undefined) {
      this.unavailable();

      return;
    }

    this.press(isRepeat);
  }

  attach(target: BrowserWindow) {
    target.webContents.on("before-input-event", (event, input) => {
      // Match the menu's logical Q on every keyboard layout, rather than the physical US key.
      const q = input.key.toLowerCase() === "q";
      const modifier = this.platform === "darwin" ? input.meta : input.control;
      const modifierKey = input.key === (this.platform === "darwin" ? "Meta" : "Control");

      if (input.type === "keyUp" && (q || (modifierKey && !modifier))) this.release();

      if (!q || !modifier || input.alt || input.shift || input.isComposing) return;
      // Prevent Chromium and the menu accelerator from also handling this physical key event.
      event.preventDefault();

      if (input.type === "keyDown") this.press(input.isAutoRepeat);
    });
    target.on("blur", () => this.cancel("blur"));
    target.on("closed", () => this.cancel("closed"));
    target.webContents.on("did-start-navigation", () => this.cancel("navigation"));
  }
}
