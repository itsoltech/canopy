interface Tick {
  readonly interval: number;
  readonly update: (now: number) => void;
  next: number;
}

const ticks = new Set<Tick>();
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  clearTimeout(timer);
  timer = undefined;

  if (!ticks.size || document.hidden) return;
  const next = Math.min(...Array.from(ticks, (tick) => tick.next));
  timer = setTimeout(publish, Math.max(0, next - Date.now()));
}

function publish() {
  const now = Date.now();

  for (const tick of ticks) {
    if (tick.next > now) continue;
    tick.next = (Math.floor(now / tick.interval) + 1) * tick.interval;
    tick.update(now);
  }

  schedule();
}

function visibilityChanged() {
  if (!document.hidden) {
    const now = Date.now();

    for (const tick of ticks) {
      tick.next = (Math.floor(now / tick.interval) + 1) * tick.interval;
      tick.update(now);
    }
  }

  schedule();
}

/** One timer at the finest subscribed cadence. No subscribers or a hidden page means no timer. */
export function subscribeTime(update: (now: number) => void, interval = 1000): () => void {
  const now = Date.now();
  const tick = { interval, update, next: (Math.floor(now / interval) + 1) * interval };

  if (!ticks.size) document.addEventListener("visibilitychange", visibilityChanged);
  ticks.add(tick);
  update(now);
  schedule();

  return () => {
    ticks.delete(tick);
    schedule();

    if (!ticks.size) document.removeEventListener("visibilitychange", visibilityChanged);
  };
}
