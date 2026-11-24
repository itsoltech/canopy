import { browser } from "$app/env";
import { onMount } from "svelte";
import { MediaQuery } from "svelte/reactivity";

const idleKeys = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Meta",
  "Shift",
  "Dead",
  "Process",
  "Unidentified",
]);

function startsKeyboardNavigation(event: KeyboardEvent): boolean {
  if (event.isComposing || event.getModifierState("AltGraph") || idleKeys.has(event.key)) return false;

  if (event.ctrlKey || event.metaKey) return true;

  // Typing into a pointer-focused field (including Option/Alt characters) leaves its ring hidden.
  if (event.target instanceof Element && event.target.matches(":read-write"))
    return event.key.length > 1 && event.key !== "Backspace" && event.key !== "Delete";

  return true;
}

export function applyDesktopFocusIndicators(preference: () => string): (keyboard: boolean) => void {
  // The detached Preview uses the desktop BFF but deliberately has no preload bridge.
  const desktop = browser && (Boolean(window.canopyDesktop) || document.documentElement.dataset.client === "desktop");
  let keyboard = $state(false);
  const forcedColors = new MediaQuery("(forced-colors: active)");

  onMount(() => {
    if (!desktop) return;

    // Capture before controls handle the event. A later focus() or dialog.close() keeps its cause.
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    window.addEventListener("pointerdown", () => (keyboard = false), options);
    window.addEventListener(
      "keydown",
      (event) => {
        if (startsKeyboardNavigation(event)) keyboard = true;
      },
      options,
    );

    return () => controller.abort();
  });

  $effect(() => {
    if (!desktop) return;

    const mode = preference();
    document.documentElement.dataset.focusRings =
      forcedColors.current || mode === "always" || (mode === "keyboard" && keyboard) ? "visible" : "hidden";
  });

  // Native menu accelerators can reach Electron before the renderer receives a keydown.
  return (fromKeyboard) => {
    keyboard = fromKeyboard;
  };
}
