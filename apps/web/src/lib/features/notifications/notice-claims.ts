import { Schema } from "effect";

/**
 * Tabs and windows of one origin share these in localStorage: events already shown and the view a focused
 * window shows. Without storage every tab decides alone.
 */
const SENT = "canopy:notifications:sent";
const VIEWING = "canopy:notifications:viewing";
const KEEP_MS = 30 * 60_000;
const VIEWING_FRESH_MS = 15_000;
const tab = crypto.randomUUID();

const Sent = Schema.Record(Schema.String, Schema.Number);
const Viewing = Schema.Struct({ tab: Schema.String, path: Schema.String, at: Schema.Number });

function parse<T>(schema: Schema.Decoder<T>, raw: string | null): T | undefined {
  if (!raw) return undefined;

  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function claim(key: string): boolean {
  try {
    const now = Date.now();
    const sent = Object.entries(parse(Sent, localStorage.getItem(SENT)) ?? {}).filter(([, at]) => now - at < KEEP_MS);

    if (sent.some(([k]) => k === key)) return false;
    localStorage.setItem(SENT, JSON.stringify(Object.fromEntries([...sent, [key, now]])));
  } catch {
    // Storage denied: this tab still shows its own events.
  }

  return true;
}

/** How long the first tab holds an event's lock: past the 5 s bot polls of other tabs and localStorage sync. */
const HOLD_MS = 15_000;

/**
 * True only for the first tab or window that shows this event. The browser coordinates Web Locks across
 * processes; localStorage alone syncs between tabs with a delay, so it only covers later arrivals.
 */
export async function claimNotice(key: string): Promise<boolean> {
  if (!("locks" in navigator)) return claim(key);
  const { promise, resolve } = Promise.withResolvers<boolean>();

  void navigator.locks
    .request(`canopy:notice:${key}`, { ifAvailable: true }, async (lock) => {
      const first = Boolean(lock) && claim(key);
      resolve(first);

      if (first) await new Promise((done) => setTimeout(done, HOLD_MS));
    })
    .catch(() => resolve(claim(key)));

  return promise;
}

/** Another focused, visible tab or window shows this path now. */
export function viewedElsewhere(path: string): boolean {
  try {
    const viewing = parse(Viewing, localStorage.getItem(VIEWING));

    return Boolean(
      viewing && viewing.tab !== tab && viewing.path === path && Date.now() - viewing.at < VIEWING_FRESH_MS,
    );
  } catch {
    return false;
  }
}

function forget(): void {
  try {
    if (parse(Viewing, localStorage.getItem(VIEWING))?.tab === tab) localStorage.removeItem(VIEWING);
  } catch {
    // Storage denied: nothing was published.
  }
}

/** Publishes this window's view while it has focus and is visible; returns the cleanup. */
export function trackViewing(path: () => string): () => void {
  const update = () => {
    if (!document.hasFocus() || document.hidden) return forget();

    try {
      const current = parse(Viewing, localStorage.getItem(VIEWING));
      const now = Date.now();
      const next = path();

      if (current?.tab === tab && current.path === next && now - current.at < VIEWING_FRESH_MS / 3) return;
      localStorage.setItem(VIEWING, JSON.stringify({ tab, path: next, at: now }));
    } catch {
      // Storage denied: other tabs only miss this window's view.
    }
  };

  const timer = setInterval(update, 1000);
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  window.addEventListener("pagehide", forget);
  document.addEventListener("visibilitychange", update);
  update();

  return () => {
    clearInterval(timer);
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    window.removeEventListener("pagehide", forget);
    document.removeEventListener("visibilitychange", update);
    forget();
  };
}
