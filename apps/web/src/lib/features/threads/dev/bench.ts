import { flushSync, tick } from "svelte";

/**
 * Timing helpers of the dev benchmark (`/dev/long-thread`). Each figure includes Svelte's update and
 * the browser's layout (a forced read of `scrollHeight`); frame figures include paint.
 */
export interface BenchResult {
  rows: number;
  /** Elements inside the scroller. */
  nodes: number;
  /** Mount of the whole timeline until the second animation frame (layout and paint included). */
  mountMs: number;
  /** One streaming delta: state update, DOM update, layout. */
  deltaAvgMs: number;
  deltaP95Ms: number;
  /** Distance from the bottom after streaming (0 = followed the stream). */
  afterStreamGap: number;
  /** Frames while scrolling from the bottom to the top in steps. */
  scrollFrameAvgMs: number;
  scrollFrameMaxMs: number;
  /** Frames over 50 ms during the sweep. */
  longFrames: number;
}

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
const round = (value: number) => Math.round(value * 100) / 100;

/** Time from `remount()` (e.g. toggling a {#key}) until two frames later. */
export async function measureMount(remount: () => void): Promise<number> {
  const start = performance.now();
  remount();
  await tick();
  await frame();
  await frame();
  return round(performance.now() - start);
}

/** Scrolls to the end and lets the scroll land (a reader at the bottom when a turn starts). */
export async function toEnd(scroller: HTMLElement): Promise<void> {
  scroller.scrollTop = scroller.scrollHeight;
  await frame();
  await frame();
}

export async function measureStream(scroller: HTMLElement, apply: (index: number) => boolean): Promise<{ avg: number; p95: number; gap: number }> {
  const times: number[] = [];
  for (let i = 0; ; i++) {
    const start = performance.now();
    if (!apply(i)) break;
    flushSync();
    void scroller.scrollHeight;
    times.push(performance.now() - start);
    // Let resize observers and the browser catch up now and then, as a live stream would.
    if (i % 10 === 9) await frame();
  }
  await frame();
  await frame();
  const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  return { avg: round(times.reduce((a, b) => a + b, 0) / Math.max(1, times.length)), p95: round(percentile(times, 0.95)), gap: Math.round(gap) };
}

export async function measureScroll(scroller: HTMLElement, steps = 80): Promise<{ avg: number; max: number; long: number }> {
  scroller.scrollTop = scroller.scrollHeight;
  await frame();
  await frame();
  const durations: number[] = [];
  let last = await frame();
  for (let i = 1; i <= steps; i++) {
    // Each step moves by most of a viewport, like a fast fling or Page Up.
    scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * 0.9);
    const now = await frame();
    durations.push(now - last);
    last = now;
    if (scroller.scrollTop <= 0) break;
  }
  return { avg: round(durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length)), max: round(Math.max(...durations)), long: durations.filter((d) => d > 50).length };
}
