import { isApple } from "#lib/shared/ui/hotkeys.ts";

const modifiers = ["Mod", "Ctrl", "Meta", "Alt", "Shift"] as const;

const keyNames = [
  "Enter",
  "Tab",
  "Escape",
  "Space",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

export function normalizeBinding(value: string): string | undefined {
  const parts = value.trim().split("+");
  const raw = parts.pop() ?? "";

  const key =
    raw.length === 1
      ? raw.toUpperCase()
      : (keyNames.find((k) => k.toLowerCase() === raw.toLowerCase()) ?? raw.toUpperCase());

  if (!/^[A-Z0-9]$|^F(?:[1-9]|1[0-2])$/.test(key) && !keyNames.includes(key)) return undefined;
  const selected = parts.map((p) => modifiers.find((m) => m.toLowerCase() === p.toLowerCase()));

  if (selected.some((p) => !p) || new Set(selected).size !== selected.length) return undefined;

  return [...modifiers.filter((m) => selected.includes(m)), key].join("+");
}

/** Compare Mod with its actual platform key so Ctrl+B and Mod+B conflict on Linux. */
export function bindingIdentity(value: string): string {
  return (
    normalizeBinding([...new Set(value.replace(/\bMod\b/g, isApple() ? "Meta" : "Ctrl").split("+"))].join("+")) ?? value
  );
}

export function recordBinding(event: KeyboardEvent): string | undefined {
  if (["Control", "Alt", "Meta", "Shift", "Dead", "Unidentified"].includes(event.key)) return undefined;

  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3)
    : /^Digit\d$/.test(event.code)
      ? event.code.slice(5)
      : event.key === " "
        ? "Space"
        : event.key;

  return normalizeBinding(
    [
      event.ctrlKey ? (isApple() ? "Ctrl" : "Mod") : "",
      event.metaKey ? (isApple() ? "Mod" : "Meta") : "",
      event.altKey ? "Alt" : "",
      event.shiftKey ? "Shift" : "",
      key,
    ]
      .filter(Boolean)
      .join("+"),
  );
}

export function bindingProblem(value: string, composer = false): string | undefined {
  if (!normalizeBinding(value)) return "Use a key such as Mod+Shift+P, Alt+J or F8.";
  const identity = bindingIdentity(value);
  const primary = isApple() ? "Meta" : "Ctrl";

  if (
    ["W", "Q", "T", "N", "L", "R"].some((k) => identity === `${primary}+${k}`) ||
    identity === "Alt+F4" ||
    identity === `${primary}+Shift+N`
  )
    return "The browser or operating system reserves this shortcut. Choose another combination.";

  if (
    ["Escape", "Tab", "Backspace", "Delete", "Space", "Home", "End", "PageUp", "PageDown"].includes(identity) ||
    identity.startsWith("Arrow") ||
    (!composer && identity === "Enter")
  )
    return "This key is reserved for navigation and typing. Add a modifier key.";

  return undefined;
}
