import type { Attachment } from "svelte/attachments";

/**
 * Keyboard shortcuts written as `"Mod+Shift+F"`, `"Mod+1"`, `"Escape"`, `"Alt+ArrowUp"`.
 * `Mod` is ⌘ on Apple platforms and Ctrl elsewhere. Letters and digits match the physical key
 * (`event.code`), so Alt/Option and keyboard layouts do not change what fires.
 *
 *   <div {@attach hotkeys({ "Mod+K": open, "Mod+1": () => pick(0) })}>   // while focus is inside
 *   {@attach hotkeys({ "Mod+K": open }, { global: true })}               // anywhere on the page
 *   if (matchesHotkey(event, "Mod+Enter")) …                             // in your own handler
 *   formatHotkey("Mod+Shift+F")  // "⇧⌘F" on a Mac, "Ctrl+Shift+F" elsewhere (use <Kbd> to show it)
 */

export const isApple = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

interface Parsed {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly key: string;
}

function parse(hotkey: string): Parsed {
  const parts = hotkey.split("+");
  const key = parts.pop() ?? "";
  const has = (name: string) => parts.some((p) => p.toLowerCase() === name);

  return { mod: has("mod"), ctrl: has("ctrl"), meta: has("meta"), shift: has("shift"), alt: has("alt"), key };
}

/** The key part of an event comparable with a hotkey's: physical letter/digit, else the key name. */
function keyOf(event: KeyboardEvent): string {
  const code = event.code;

  if (/^Key[A-Z]$/.test(code)) return code.slice(3);

  if (/^Digit\d$/.test(code)) return code.slice(5);

  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

export function matchesHotkey(event: KeyboardEvent, hotkey: string): boolean {
  const want = parse(hotkey);
  const apple = isApple();
  const ctrl = want.ctrl || (want.mod && !apple);
  const meta = want.meta || (want.mod && apple);

  return (
    event.ctrlKey === ctrl &&
    event.metaKey === meta &&
    event.shiftKey === want.shift &&
    event.altKey === want.alt &&
    keyOf(event).toUpperCase() === want.key.toUpperCase()
  );
}

const appleSymbols: Record<string, string> = { mod: "⌘", meta: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥" };

const keyNames: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "↵",
  Escape: "Esc",
  " ": "Space",
};

/** Keys of a hotkey for display, one string per key (`["⇧", "⌘", "F"]` or `["Ctrl", "Shift", "F"]`). */
export function hotkeyKeys(hotkey: string): string[] {
  const { key, ...mods } = parse(hotkey);
  const apple = isApple();
  const key_ = keyNames[key] ?? (key.length === 1 ? key.toUpperCase() : key);

  if (apple) {
    // Apple order: ⌃ ⌥ ⇧ ⌘.
    const order = (["ctrl", "alt", "shift", "mod", "meta"] as const).filter((m) => mods[m]);

    return [...order.map((m) => appleSymbols[m] ?? m), key_];
  }

  const names = [
    mods.mod || mods.ctrl ? "Ctrl" : "",
    mods.meta ? "Meta" : "",
    mods.alt ? "Alt" : "",
    mods.shift ? "Shift" : "",
  ].filter(Boolean);

  return [...names, key_];
}

/** A hotkey as one string: "⇧⌘F" (Apple) or "Ctrl+Shift+F". */
export const formatHotkey = (hotkey: string): string => hotkeyKeys(hotkey).join(isApple() ? "" : "+");

export type HotkeyMap = Readonly<Record<string, (event: KeyboardEvent) => void>>;

/**
 * Attachment binding a map of hotkeys. Scoped to the element (focus inside it) by default, or to the
 * whole window with `global`. A matched hotkey's default action is prevented.
 */
export function hotkeys(map: HotkeyMap, { global = false }: { global?: boolean } = {}): Attachment<HTMLElement> {
  return (node) => {
    const target: HTMLElement | Window = global ? window : node;

    const onkeydown = (event: Event) => {
      const keyboard = event as KeyboardEvent;

      if (keyboard.isComposing || keyboard.defaultPrevented) return;

      for (const [hotkey, run] of Object.entries(map)) {
        if (matchesHotkey(keyboard, hotkey)) {
          keyboard.preventDefault();
          run(keyboard);

          return;
        }
      }
    };

    target.addEventListener("keydown", onkeydown);

    return () => target.removeEventListener("keydown", onkeydown);
  };
}
