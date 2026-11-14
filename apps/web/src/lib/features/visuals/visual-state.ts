import type { VisualState } from "@canopy/domain/visuals";

/**
 * Local control state per visual version, cached on this device only: 64 entries and 256 KiB, oldest first out.
 * Never synced or sent anywhere; a cleared cache or a new version starts from the visual's initial state.
 */
const KEY = "canopy.visual-state.v1";
const MAX_ENTRIES = 64;
const MAX_BYTES = 256 * 1024;

type Entries = [string, VisualState][];

const isEntries = (value: unknown): value is Entries => Array.isArray(value);

function read(): Entries {
  try {
    // Written only by saveVisualState; the frame host validates every entry against its spec before use.
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");

    return isEntries(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function savedVisualState(visualId: string, version: number): VisualState | undefined {
  return read().find(([key]) => key === `${visualId}@${version}`)?.[1];
}

export function saveVisualState(visualId: string, version: number, state: VisualState): void {
  const key = `${visualId}@${version}`;
  const entry: [string, VisualState] = [key, state];
  const entries = [...read().filter(([existing]) => existing !== key), entry];

  while (entries.length > MAX_ENTRIES || JSON.stringify(entries).length > MAX_BYTES) entries.shift();

  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Storage full or disabled: the visual keeps working from its initial state.
  }
}
