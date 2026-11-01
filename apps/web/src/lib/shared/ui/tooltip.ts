import type { Attachment } from "svelte/attachments";
import { positionNow, type Placement } from "./floating.ts";
import { hotkeyKeys, isApple } from "./hotkeys.ts";

/**
 * Tooltip as an attachment: a short label in the top layer, shown after a hover delay (instantly while
 * another tooltip was just open), at once on keyboard focus, hidden on leave, blur, Escape or press.
 * Touch screens have no hover: a long press shows it for a moment instead. It describes the element
 * (`aria-describedby`) unless the text already is its accessible name (`aria-label`).
 *
 *   <button aria-label="Send" {@attach tooltip("Send", { hotkey: "Enter" })}>…</button>
 */
export interface TooltipOptions {
  readonly placement?: Placement;
  /** Shortcut shown after the text (`"Mod+Enter"`). */
  readonly hotkey?: string | undefined;
  /** Hover delay, ms. */
  readonly delay?: number;
}

let lastHidden = 0;
// Focus shows a tooltip only when the keyboard moved it (not when a closing menu hands focus back after a click).
let keyboardLast = false;
let modalityTracked = false;
function trackModality() {
  if (modalityTracked) return;
  modalityTracked = true;
  document.addEventListener("keydown", () => (keyboardLast = true), true);
  document.addEventListener("pointerdown", () => (keyboardLast = false), true);
}
const WARM_MS = 400;
let counter = 0;

export function tooltip(text: string | undefined, { placement = "top", hotkey, delay = 500 }: TooltipOptions = {}): Attachment<HTMLElement> {
  return (node) => {
    if (!text) return;
    const tip = document.createElement("div");
    tip.id = `tooltip-${++counter}`;
    tip.popover = "manual";
    tip.setAttribute("role", "tooltip");
    tip.className =
      "fixed inset-auto top-(--float-y) left-(--float-x) m-0 max-w-64 open:flex items-center gap-2 rounded-md border-0 bg-zinc-950 px-2 py-1 text-xs/4 text-white shadow-md pointer-events-none dark:bg-zinc-700 dark:shadow-none";
    tip.append(document.createTextNode(text));
    if (hotkey) {
      const kbd = document.createElement("kbd");
      kbd.className = "font-sans text-zinc-400 dark:text-zinc-300";
      kbd.textContent = hotkeyKeys(hotkey).join(isApple() ? "" : "+");
      tip.append(kbd);
    }
    document.body.append(tip);
    if (node.getAttribute("aria-label") !== text) node.setAttribute("aria-describedby", tip.id);
    let timer: ReturnType<typeof setTimeout> | undefined;

    trackModality();
    const show = () => {
      clearTimeout(timer);
      // Not over its own open menu or popover.
      if (!node.isConnected || node.getAttribute("aria-expanded") === "true") return;
      if (!tip.matches(":popover-open")) tip.showPopover();
      positionNow(node, tip, { placement, offset: 6 });
    };
    const hide = () => {
      clearTimeout(timer);
      if (tip.matches(":popover-open")) {
        tip.hidePopover();
        lastHidden = Date.now();
      }
    };
    const later = (ms: number, run: () => void) => {
      clearTimeout(timer);
      timer = setTimeout(run, ms);
    };

    const onpointerenter = (event: PointerEvent) => {
      if (event.pointerType === "mouse") later(Date.now() - lastHidden < WARM_MS ? 0 : delay, show);
    };
    const onpointerleave = (event: PointerEvent) => {
      if (event.pointerType === "mouse") hide();
    };
    // Touch fallback: long press shows the tip briefly.
    const onpointerdown = (event: PointerEvent) => {
      if (event.pointerType === "mouse") {
        hide();
        clearTimeout(timer);
        return;
      }
      later(500, () => {
        show();
        later(1500, hide);
      });
    };
    const onpointerup = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && !tip.matches(":popover-open")) clearTimeout(timer);
    };
    const onfocus = () => {
      if (keyboardLast && node.matches(":focus-visible")) show();
    };
    const onkeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && tip.matches(":popover-open")) hide();
    };

    node.addEventListener("pointerenter", onpointerenter);
    node.addEventListener("pointerleave", onpointerleave);
    node.addEventListener("pointerdown", onpointerdown);
    node.addEventListener("pointerup", onpointerup);
    node.addEventListener("pointercancel", hide);
    node.addEventListener("focus", onfocus);
    node.addEventListener("blur", hide);
    node.addEventListener("keydown", onkeydown);
    return () => {
      hide();
      tip.remove();
      if (node.getAttribute("aria-describedby") === tip.id) node.removeAttribute("aria-describedby");
      node.removeEventListener("pointerenter", onpointerenter);
      node.removeEventListener("pointerleave", onpointerleave);
      node.removeEventListener("pointerdown", onpointerdown);
      node.removeEventListener("pointerup", onpointerup);
      node.removeEventListener("pointercancel", hide);
      node.removeEventListener("focus", onfocus);
      node.removeEventListener("blur", hide);
      node.removeEventListener("keydown", onkeydown);
    };
  };
}
