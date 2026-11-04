import type { QuitGuardState, QuitShortcut } from "@canopy/ui/desktop";

export const DOUBLE_PRESS_MS = 500;
export const HOLD_MS = 1_000;
const HINT_MS = 2_500;
const REPEAT_MARGIN_MS = 100;

export interface KeyRepeatTiming {
  initialDelayMs: number;
  intervalMs: number;
}

export interface QuitClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface QuitMachineOptions {
  clock: QuitClock;
  shortcut: string;
  repeatTiming(): KeyRepeatTiming | null;
  emit(state: QuitGuardState): void;
  quit(): void;
  log(decision: string): void;
}

/** Prefer AppKit's effective timing (also works with unset defaults); ticks are a fallback. */
export function macKeyRepeatTiming(
  initial: number,
  interval: number,
  effective?: KeyRepeatTiming,
): KeyRepeatTiming | null {
  // Respect an explicit Repeat Off sentinel even if AppKit still has cached timings.
  if (initial < 0 || interval < 0 || initial * 15 > 5_000 || interval * 15 > 500) return null;
  const timing = effective ?? { initialDelayMs: initial * 15, intervalMs: interval * 15 };

  if (
    !Number.isFinite(timing.initialDelayMs) ||
    !Number.isFinite(timing.intervalMs) ||
    timing.initialDelayMs <= 0 ||
    timing.intervalMs <= 0 ||
    timing.initialDelayMs > 5_000 ||
    timing.intervalMs > 500
  )
    return null;

  return timing;
}

/** No Electron, wall clock or input inference: callers supply the native repeat bit. */
export class QuitMachine {
  private timer: unknown;
  private armedAt: number | undefined;
  private hold: { startedAt: number; deadline: number; durationMs: number; timing: KeyRepeatTiming } | undefined;

  constructor(
    public mode: QuitShortcut,
    private readonly options: QuitMachineOptions,
  ) {}

  private clearTimer() {
    if (this.timer !== undefined) this.options.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private publish(phase: QuitGuardState["phase"], durationMs = 0, message?: string) {
    this.options.emit({ phase, durationMs, shortcut: this.options.shortcut, ...(message && { message }) });
  }

  cancel(reason = "cancel") {
    this.clearTimer();
    this.armedAt = undefined;
    this.hold = undefined;
    this.options.log(`cancel reason=${reason}`);
    this.publish("cancel");
  }

  private quit() {
    this.cancel("quit");
    this.options.log("quit");
    this.options.quit();
  }

  release() {
    this.options.log("release");

    // A release separates presses, but must not disarm the double-press window.
    if (this.hold) this.cancel("release");
  }

  unavailable() {
    this.cancel("repeat-metadata-unavailable");
    this.hint("Use Quit Canopy from the application menu to quit");
  }

  private hint(message = `Press ${this.options.shortcut} twice to quit`) {
    this.clearTimer();
    this.publish("hint", HINT_MS, message);
    this.timer = this.options.clock.setTimeout(() => this.cancel("hint-timeout"), HINT_MS);
  }

  press(isRepeat: boolean) {
    const now = this.options.clock.now();
    this.options.log(isRepeat ? "repeat" : "press");

    if (this.mode === "immediately") {
      this.quit();

      return;
    }

    if (this.hold) {
      if (!isRepeat) {
        this.cancel("new-press");
      } else if (now >= this.hold.deadline) {
        this.cancel("repeat-timeout");

        return;
      } else {
        // Quit only on positive evidence of a held key, never from a duration timer.
        if (now - this.hold.startedAt >= this.hold.durationMs) {
          this.quit();

          return;
        }

        this.hold.deadline = now + this.hold.timing.intervalMs + REPEAT_MARGIN_MS;
        this.watchHold();

        return;
      }
    }

    // A repeat can neither arm nor confirm Press twice, nor restart a cancelled hold.
    if (isRepeat) return;

    const timing = this.options.repeatTiming();

    if (this.mode === "press-twice" || !timing) {
      if (this.armedAt !== undefined && now - this.armedAt < DOUBLE_PRESS_MS) {
        this.quit();

        return;
      }

      this.cancel("first-press");
      this.armedAt = now;

      if (this.mode === "hold")
        this.publish("hint", HINT_MS, `Hold needs key repeat. Press ${this.options.shortcut} twice to quit`);
      this.timer = this.options.clock.setTimeout(() => {
        this.armedAt = undefined;
        this.options.log("timeout double-press");
        this.hint(
          this.mode === "hold" ? `Hold needs key repeat. Press ${this.options.shortcut} twice to quit` : undefined,
        );
      }, DOUBLE_PRESS_MS);

      return;
    }

    this.cancel("hold-start");
    const durationMs = Math.max(HOLD_MS, timing.initialDelayMs + timing.intervalMs);
    this.hold = { startedAt: now, deadline: now + timing.initialDelayMs + REPEAT_MARGIN_MS, durationMs, timing };
    this.publish("holding", durationMs);
    this.watchHold();
  }

  private watchHold() {
    this.clearTimer();
    this.timer = this.options.clock.setTimeout(() => {
      this.options.log("timeout repeat");
      this.cancel("repeat-timeout");
    }, this.hold!.deadline - this.options.clock.now());
  }
}
