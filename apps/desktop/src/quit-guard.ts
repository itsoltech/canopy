import type { BrowserWindow } from "electron";
import type { QuitGuardState, QuitShortcut } from "@canopy/ui/desktop";

const DOUBLE_PRESS_MS = 1_500;
const HOLD_MS = 1_000;

/** Only keyboard requests enter the guard; app.quit() remains an unconditional lifecycle operation. */
export class QuitGuard {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private armedUntil = 0;
  private holding = false;
  private readonly shortcut = process.platform === "darwin" ? "⌘Q" : "Ctrl+Q";
  constructor(public mode: QuitShortcut, private readonly quit: () => void, private readonly emit: (state: QuitGuardState) => void) {}

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.armedUntil = 0;
    this.holding = false;
    this.emit({ phase: "cancel", shortcut: this.shortcut, durationMs: 0 });
  }

  /** With no focused renderer there is no reliable key-up: the menu accelerator quits immediately. */
  accelerator(focused: BrowserWindow | null) {
    if (!focused) { this.cancel(); this.quit(); return; }
    this.press();
  }

  private press() {
    if (this.mode === "immediately") { this.quit(); return; }
    if (this.mode === "press-twice") {
      if (Date.now() < this.armedUntil) { this.cancel(); this.quit(); return; }
      this.cancel();
      this.armedUntil = Date.now() + DOUBLE_PRESS_MS;
      this.emit({ phase: "hint", shortcut: this.shortcut, durationMs: DOUBLE_PRESS_MS });
      this.timer = setTimeout(() => this.cancel(), DOUBLE_PRESS_MS);
      return;
    }
    if (this.holding) return;
    this.cancel();
    this.holding = true;
    this.emit({ phase: "holding", shortcut: this.shortcut, durationMs: HOLD_MS });
    this.timer = setTimeout(() => { this.cancel(); this.quit(); }, HOLD_MS);
  }

  attach(target: BrowserWindow) {
    target.webContents.on("before-input-event", (event, input) => {
      // Match the menu's logical Q on every keyboard layout, rather than the physical US key.
      const q = input.key.toLowerCase() === "q";
      const modifier = process.platform === "darwin" ? input.meta : input.control;
      if (input.type === "keyUp" && this.holding && (q || !modifier)) this.cancel();
      if (!q || !modifier || input.alt || input.shift || input.isComposing) return;
      // Prevent Chromium and the menu accelerator from also handling this physical key event.
      event.preventDefault();
      if (input.type === "keyDown" && !input.isAutoRepeat) this.press();
    });
    target.on("blur", () => this.cancel());
    target.on("closed", () => this.cancel());
    target.webContents.on("did-start-navigation", () => this.cancel());
  }
}
