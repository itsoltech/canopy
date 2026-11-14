import { File, Paths } from "expo-file-system";
import { isJsonArray, isJsonObject, isNumber, isString, parseJson } from "@canopy/domain/json";
import type { VisualState } from "@canopy/domain/visuals";

/**
 * Local control state per visual version, cached on this phone only: 64 entries and 256 KiB, oldest first out.
 * Never synced or sent anywhere; a cleared cache or a new version starts from the visual's initial state. The
 * WebView host checks every entry against its spec before a visual gets it back.
 */
const MAX_ENTRIES = 64;
const MAX_BYTES = 256 * 1024;
const file = () => new File(Paths.cache, "visual-state.json");

let entries: [string, VisualState][] | undefined;
let loading: Promise<void> | undefined;
let writing = Promise.resolve();

function parse(raw: string): [string, VisualState][] {
  const stored = parseJson(raw);

  if (!isJsonArray(stored)) return [];

  return stored.flatMap((entry) => {
    if (!isJsonArray(entry) || !isString(entry[0]) || !isJsonObject(entry[1])) return [];

    const state: VisualState = Object.fromEntries(
      Object.entries(entry[1]).filter(
        (pair): pair is [string, string | number | boolean] =>
          isString(pair[1]) || isNumber(pair[1]) || pair[1] === true || pair[1] === false,
      ),
    );

    return [[entry[0], state]];
  });
}

/** Reads the cache file once; later reads come from memory. */
export function loadVisualStates(): Promise<void> {
  loading ??= (async () => {
    try {
      const stored = file();
      entries = stored.exists ? parse(await stored.text()) : [];
    } catch {
      entries = [];
    }
  })();

  return loading;
}

export function savedVisualState(visualId: string, version: number): VisualState | undefined {
  return entries?.find(([key]) => key === `${visualId}@${version}`)?.[1];
}

export function saveVisualState(visualId: string, version: number, state: VisualState): void {
  const key = `${visualId}@${version}`;
  const next: [string, VisualState][] = [...(entries ?? []).filter(([existing]) => existing !== key), [key, state]];

  while (next.length > MAX_ENTRIES || JSON.stringify(next).length > MAX_BYTES) next.shift();
  entries = next;
  const text = JSON.stringify(next);

  writing = writing
    .then(async () => {
      const stored = file();

      if (!stored.exists) stored.create();
      await stored.write(text);
    })
    // Storage full or unavailable: the visual keeps working from its initial state.
    .catch(() => undefined);
}
