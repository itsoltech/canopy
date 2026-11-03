import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import type { QuitGuardState, QuitShortcut } from "@canopy/ui/desktop";
import { QuitGuard } from "../src/quit-guard.ts";
import { QuitFeedback } from "../src/quit-feedback.ts";
import { macKeyRepeatTiming, QuitMachine, type KeyRepeatTiming, type QuitClock } from "../src/quit-machine.ts";

class Clock implements QuitClock {
  time = 0;
  private sequence = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(timer: unknown) { this.timers.delete(timer as number); }
  advance(to: number) {
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > to) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = to;
  }
}

function fixture(mode: QuitShortcut, timing: KeyRepeatTiming | null = { initialDelayMs: 450, intervalMs: 45 }) {
  const clock = new Clock();
  const states: QuitGuardState[] = [];
  const decisions: string[] = [];
  const quits: number[] = [];
  const options = { clock, shortcut: "⌘Q", repeatTiming: () => timing, emit: (state: QuitGuardState) => states.push(state), quit: () => { quits.push(clock.now()); }, log: (decision: string) => { decisions.push(decision); } };
  return { machine: new QuitMachine(mode, options), options, clock, states, decisions, quits };
}

describe("quit state machine", () => {
  test("a quick Hold tap without ANY keyUp never quits", () => {
    const f = fixture("hold");
    f.machine.press(false);
    expect(f.states.at(-1)?.phase).toBe("holding");
    f.clock.advance(550);
    expect(f.states.at(-1)?.phase).toBe("cancel");
    f.clock.advance(10_000);
    expect(f.quits).toEqual([]);
    expect(f.decisions).toContain("timeout repeat");
  });

  test("holding with continuous repeats quits on the first repeat after one second", () => {
    const f = fixture("hold");
    f.machine.press(false);
    for (let time = 450; time <= 990; time += 45) { f.clock.advance(time); f.machine.press(true); }
    f.clock.advance(1_000);
    expect(f.quits).toEqual([]); // No unconditional duration timer.
    f.clock.advance(1_035);
    f.machine.press(true);
    expect(f.quits).toEqual([1_035]);
    expect(f.clock.timers.size).toBe(0);
  });

  test("stopped repeats cancel and a stray late repeat cannot restart Hold", () => {
    const f = fixture("hold");
    f.machine.press(false);
    f.clock.advance(450); f.machine.press(true);
    f.clock.advance(495); f.machine.press(true);
    f.clock.advance(640);
    expect(f.states.at(-1)?.phase).toBe("cancel");
    f.clock.advance(1_100); f.machine.press(true);
    expect(f.quits).toEqual([]);
    expect(f.states.at(-1)?.phase).toBe("cancel");
  });

  test("a late repeat cannot beat a delayed watchdog callback", () => {
    const f = fixture("hold");
    f.machine.press(false);
    f.clock.time = 1_100; // Simulate a blocked main loop, before timers run.
    f.machine.press(true);
    expect(f.quits).toEqual([]);
    expect(f.states.at(-1)?.phase).toBe("cancel");
  });

  test("Meta release cancels Hold and discards pending timers", () => {
    const f = fixture("hold");
    f.machine.press(false);
    f.clock.advance(450); f.machine.press(true);
    f.machine.release();
    f.clock.advance(2_000);
    expect(f.quits).toEqual([]);
    expect(f.states.at(-1)?.phase).toBe("cancel");
    expect(f.decisions).toContain("release");
  });

  test("long initial delay requires holding through its repeat window", () => {
    const f = fixture("hold", { initialDelayMs: 1_500, intervalMs: 45 });
    f.machine.press(false);
    expect(f.states.at(-1)?.durationMs).toBe(1_545);
    f.clock.advance(1_000);
    expect(f.quits).toEqual([]);
    f.clock.advance(1_500); f.machine.press(true);
    expect(f.quits).toEqual([]);
    f.clock.advance(1_545); f.machine.press(true);
    expect(f.quits).toEqual([1_545]);
  });

  test("repeat off uses Press twice, with a visible explanation, and ignores repeats", () => {
    const f = fixture("hold", null);
    f.machine.press(false);
    expect(f.states.at(-1)?.message).toContain("Hold needs key repeat");
    f.clock.advance(100); f.machine.press(true);
    expect(f.quits).toEqual([]);
    f.clock.advance(200); f.machine.press(false);
    expect(f.quits).toEqual([200]);
  });

  test("a single press with repeat off never quits", () => {
    const f = fixture("hold", null);
    f.machine.press(false);
    f.clock.advance(10_000);
    expect(f.quits).toEqual([]);
  });

  test("Press twice accepts two separate presses within 500 ms, even across Meta release", () => {
    const f = fixture("press-twice");
    f.machine.press(false);
    f.machine.release();
    f.clock.advance(499); f.machine.press(false);
    expect(f.quits).toEqual([499]);
  });

  test("single press shows the hint AFTER 500 ms, for 2.5 seconds", () => {
    const f = fixture("press-twice");
    f.machine.press(false);
    f.clock.advance(499);
    expect(f.states.some((state) => state.phase === "hint")).toBe(false);
    f.clock.advance(500);
    expect(f.states.at(-1)).toEqual({ phase: "hint", shortcut: "⌘Q", durationMs: 2_500, message: "Press ⌘Q twice to quit" });
    f.clock.advance(2_999);
    expect(f.states.at(-1)?.phase).toBe("hint");
    f.clock.advance(3_000);
    expect(f.states.at(-1)?.phase).toBe("cancel");
    expect(f.quits).toEqual([]);
  });

  for (const gap of [500, 501, 1_200, 10_000]) {
    test(`a slow second press at ${gap} ms re-arms instead of quitting`, () => {
      const f = fixture("press-twice");
      f.machine.press(false);
      f.clock.advance(gap); f.machine.press(false);
      expect(f.quits).toEqual([]);
      f.clock.advance(gap + 200); f.machine.press(false);
      expect(f.quits).toEqual([gap + 200]);
    });
  }

  test("an expired double press cannot beat a delayed timeout callback", () => {
    const f = fixture("press-twice");
    f.machine.press(false);
    f.clock.time = 800;
    f.machine.press(false);
    expect(f.quits).toEqual([]);
    f.clock.advance(1_000); f.machine.press(false);
    expect(f.quits).toEqual([1_000]);
  });

  test("held key repeats before and after 500 ms never confirm or re-arm Press twice", () => {
    const f = fixture("press-twice", { initialDelayMs: 150, intervalMs: 30 });
    f.machine.press(false);
    for (let time = 150; time < 4_000; time += 30) { f.clock.advance(time); f.machine.press(true); }
    expect(f.quits).toEqual([]);
    f.machine.press(false); // A real new press is a first press.
    expect(f.quits).toEqual([]);
  });

  test("Immediate quits on the first press", () => {
    const f = fixture("immediately");
    f.machine.press(false);
    expect(f.quits).toEqual([0]);
  });

  test("macOS repeat settings are converted and disabled/extreme values fail safely", () => {
    expect(macKeyRepeatTiming(30, 3)).toEqual({ initialDelayMs: 450, intervalMs: 45 });
    expect(macKeyRepeatTiming(0, 0, { initialDelayMs: 500, intervalMs: 50 })).toEqual({ initialDelayMs: 500, intervalMs: 50 });
    expect(macKeyRepeatTiming(2_147_483_647, 3, { initialDelayMs: 500, intervalMs: 50 })).toBeNull();
    for (const [initial, interval] of [[0, 3], [-1, 3], [2_147_483_647, 3], [30, 0], [30, -1], [30, 100], [NaN, 3]]) {
      expect(macKeyRepeatTiming(initial!, interval!)).toBeNull();
    }
  });
});

function fakeWindow() {
  const target = new EventEmitter() as EventEmitter & { webContents: EventEmitter };
  target.webContents = new EventEmitter();
  return { target, window: target as unknown as BrowserWindow };
}

describe("Electron input adapter and preload delivery", () => {
  test("an outdated web listener does not suppress the bundled fallback", () => {
    const fallback: QuitGuardState[] = [];
    const feedback = new QuitFeedback((state) => fallback.push(state));
    const state: QuitGuardState = { phase: "hint", shortcut: "⌘Q", durationMs: 2_500 };
    feedback.subscribe(() => {}, false);
    feedback.receive(state);
    expect(fallback.at(-1)).toEqual(state);
    const modern: QuitGuardState[] = [];
    const off = feedback.subscribe((value) => modern.push(value), true);
    expect(fallback.at(-1)?.phase).toBe("cancel");
    expect(modern.at(-1)).toEqual(state);
    off();
    expect(fallback.at(-1)).toEqual(state);
  });
  for (const event of ["blur", "closed", "did-start-navigation"]) {
    test(`${event} cancels pending Hold and Press twice`, () => {
      for (const mode of ["hold", "press-twice"] as const) {
        const f = fixture(mode);
        const guard = new QuitGuard(mode, f.options, "darwin");
        const w = fakeWindow(); guard.attach(w.window);
        guard.accelerator(w.window, false);
        (event === "did-start-navigation" ? w.target.webContents : w.target).emit(event);
        expect(f.states.at(-1)?.phase).toBe("cancel");
        f.clock.advance(200);
        guard.accelerator(w.window, false);
        expect(f.quits).toEqual([]);
        guard.cancel();
      }
    });
  }

  test("menu repeats are Hold evidence; renderer Meta keyUp cancels them", () => {
    const f = fixture("hold");
    const guard = new QuitGuard("hold", f.options, "darwin");
    const w = fakeWindow(); guard.attach(w.window);
    guard.accelerator(w.window, false);
    f.clock.advance(450); guard.accelerator(w.window, true);
    w.target.webContents.emit("before-input-event", { preventDefault() {} }, { type: "keyUp", key: "Meta", meta: false });
    f.clock.advance(1_035); guard.accelerator(w.window, true);
    expect(f.quits).toEqual([]);
    expect(f.decisions).toContain("cancel reason=release");
  });

  test("renderer Ctrl+Q carries its repeat bit and prevents duplicate menu handling", () => {
    const f = fixture("press-twice");
    const guard = new QuitGuard("press-twice", f.options, "linux");
    const w = fakeWindow(); guard.attach(w.window);
    let prevented = 0;
    const event = { preventDefault() { prevented++; } };
    w.target.webContents.emit("before-input-event", event, { type: "keyDown", key: "q", control: true, isAutoRepeat: false });
    f.clock.advance(200);
    w.target.webContents.emit("before-input-event", event, { type: "keyDown", key: "q", control: true, isAutoRepeat: true });
    expect(f.quits).toEqual([]);
    f.clock.advance(300);
    w.target.webContents.emit("before-input-event", event, { type: "keyDown", key: "q", control: true, isAutoRepeat: false });
    expect(f.quits).toEqual([300]);
    expect(prevented).toBe(3);
  });

  test("unknown native repeat metadata and missing focus cannot bypass a protected mode", () => {
    const f = fixture("press-twice");
    const guard = new QuitGuard("press-twice", f.options, "darwin");
    guard.accelerator(fakeWindow().window, undefined);
    guard.accelerator(null, false);
    expect(f.quits).toEqual([]);
    expect(f.states.at(-1)?.message).toContain("application menu");
    guard.mode = "immediately";
    guard.accelerator(null, undefined);
    expect(f.quits).toEqual([0]);
  });

  test("both windows receive hint/cancel; a late overlay gets cached state; old web uses shell fallback", () => {
    const f = fixture("press-twice");
    const mainFallback: QuitGuardState[] = [];
    const settingsFallback: QuitGuardState[] = [];
    const main = new QuitFeedback((state) => mainFallback.push(state));
    const settings = new QuitFeedback((state) => settingsFallback.push(state));
    const settingsOverlay: QuitGuardState[] = [];
    settings.subscribe((state) => settingsOverlay.push(state));
    const machine = new QuitMachine("press-twice", { ...f.options, emit: (state) => { main.receive(state); settings.receive(state); } });
    machine.press(false); f.clock.advance(500);
    expect(mainFallback.at(-1)?.phase).toBe("hint");
    expect(settingsOverlay.at(-1)?.message).toBe("Press ⌘Q twice to quit");
    const mainOverlay: QuitGuardState[] = [];
    const off = main.subscribe((state) => mainOverlay.push(state));
    expect(mainOverlay.at(-1)?.phase).toBe("hint");
    expect(mainFallback.at(-1)?.phase).toBe("cancel");
    f.clock.advance(3_000);
    expect(mainOverlay.at(-1)?.phase).toBe("cancel");
    expect(settingsOverlay.at(-1)?.phase).toBe("cancel");
    off();
    expect(mainFallback.at(-1)?.phase).toBe("cancel");
    expect(settingsFallback).toEqual([]);
  });
});
