import { Match } from "effect";
import type { DesktopHtmlCommand, DesktopHtmlInput, DesktopHtmlModifier } from "@canopy/ui/desktop";
import { reportEmbedHover } from "#lib/shared/ui/virtual/embed-hover.ts";

function modifiers(event: KeyboardEvent | MouseEvent): DesktopHtmlModifier[] {
  const result: DesktopHtmlModifier[] = [];

  if (event.shiftKey) result.push("shift");

  if (event.ctrlKey) result.push("control");

  if (event.altKey) result.push("alt");

  if (event.metaKey) result.push("meta");

  return result;
}

const button = (value: number) =>
  Match.value(value).pipe(
    Match.when(1, () => "middle" as const),
    Match.when(2, () => "right" as const),
    Match.orElse(() => "left" as const),
  );

const keyNames = new Map([
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  ["ArrowUp", "Up"],
  ["ArrowDown", "Down"],
  [" ", "Space"],
]);

/** Input belongs only to the focused preview. Escape releases it before conversation shortcuts resume. */
class DesktopHtmlInputSession {
  private readonly keyboard = document.createElement("textarea");
  private readonly abort = new AbortController();
  private readonly keys = new Map<string, string>();
  private readonly buttons = new Set<"left" | "middle" | "right">();
  private enabled = true;
  private composing = false;

  constructor(
    private readonly surface: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly size: () => { width: number; height: number },
    private readonly command: (command: DesktopHtmlCommand) => void,
    private readonly onEscape: () => void,
  ) {
    this.keyboard.className =
      "pointer-events-none absolute bottom-0 left-0 size-px resize-none overflow-hidden border-0 p-0 opacity-0";
    this.keyboard.setAttribute("aria-label", "Visual keyboard");
    this.keyboard.autocomplete = "off";
    this.keyboard.spellcheck = false;
    this.keyboard.tabIndex = -1;
    surface.append(this.keyboard);
    this.bindPointer();
    this.bindKeyboard();
  }

  private send(event: DesktopHtmlInput) {
    if (this.enabled) this.command({ type: "input", event });
  }

  private point(event: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const bounds = this.size();

    return {
      x: Math.max(
        0,
        Math.min(bounds.width - 1, Math.round(((event.clientX - rect.left) / (rect.width || 1)) * bounds.width)),
      ),
      y: Math.max(
        0,
        Math.min(bounds.height - 1, Math.round(((event.clientY - rect.top) / (rect.height || 1)) * bounds.height)),
      ),
    };
  }

  private readonly release = () => {
    for (const keyCode of this.keys.values()) this.send({ type: "keyUp", keyCode });

    for (const value of this.buttons) this.send({ type: "mouseUp", x: 0, y: 0, button: value, clickCount: 1 });
    this.keys.clear();
    this.buttons.clear();
  };

  private bindPointer() {
    const { signal } = this.abort;
    this.canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.enabled) return;
        event.preventDefault();
        this.keyboard.focus({ preventScroll: true });
        this.canvas.setPointerCapture(event.pointerId);
        const value = button(event.button);
        this.buttons.add(value);
        this.send({
          type: "mouseDown",
          ...this.point(event),
          button: value,
          clickCount: Math.min(3, event.detail || 1),
          modifiers: modifiers(event),
        });
      },
      { signal },
    );
    this.canvas.addEventListener(
      "pointermove",
      (event) => {
        const held: DesktopHtmlModifier[] = [];

        if (event.buttons & 1) held.push("leftButtonDown");

        if (event.buttons & 2) held.push("rightButtonDown");

        if (event.buttons & 4) held.push("middleButtonDown");
        this.send({ type: "mouseMove", ...this.point(event), modifiers: [...modifiers(event), ...held] });
      },
      { signal },
    );
    this.canvas.addEventListener(
      "pointerup",
      (event) => {
        const value = button(event.button);
        this.buttons.delete(value);
        this.send({
          type: "mouseUp",
          ...this.point(event),
          button: value,
          clickCount: Math.min(3, event.detail || 1),
          modifiers: modifiers(event),
        });

        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      },
      { signal },
    );
    this.canvas.addEventListener("pointercancel", this.release, { signal });
    this.canvas.addEventListener("lostpointercapture", this.release, { signal });
    this.canvas.addEventListener(
      "wheel",
      (event) => {
        if (!this.enabled || document.activeElement !== this.keyboard) return;
        event.preventDefault();
        let unit = 1;

        if (event.deltaMode === 1) unit = 16;

        if (event.deltaMode === 2) unit = this.size().height;
        this.send({
          type: "mouseWheel",
          ...this.point(event),
          deltaX: Math.max(-1000, Math.min(1000, -event.deltaX * unit)),
          deltaY: Math.max(-1000, Math.min(1000, -event.deltaY * unit)),
          modifiers: modifiers(event),
        });
      },
      { passive: false, signal },
    );
    this.surface.addEventListener("pointerenter", () => reportEmbedHover(this.surface, true), { signal });
    this.surface.addEventListener("pointerleave", () => reportEmbedHover(this.surface, false), { signal });
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
  }

  private bindKeyboard() {
    const { signal } = this.abort;
    this.canvas.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        this.keyboard.focus({ preventScroll: true });
        this.send({ type: "keyDown", keyCode: "Tab" });
        this.send({ type: "keyUp", keyCode: "Tab" });
      },
      { signal },
    );
    this.keyboard.addEventListener(
      "keydown",
      (event) => {
        event.stopPropagation();

        if (event.isComposing || event.getModifierState("AltGraph")) return;

        if (event.key === "Escape") {
          event.preventDefault();
          this.release();
          this.canvas.focus({ preventScroll: true });
          this.onEscape();

          return;
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;

        if (event.shiftKey && event.key === "Insert") return;

        if (event.key === "Dead" || event.key === "Process") return;

        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) event.preventDefault();
        const keyCode = keyNames.get(event.key) ?? event.key;
        this.keys.set(event.code, keyCode);
        this.send({ type: "keyDown", keyCode, modifiers: modifiers(event) });
      },
      { signal },
    );
    this.keyboard.addEventListener(
      "keyup",
      (event) => {
        event.stopPropagation();
        const keyCode = this.keys.get(event.code);

        if (!keyCode) return;
        event.preventDefault();
        this.keys.delete(event.code);
        this.send({ type: "keyUp", keyCode, modifiers: modifiers(event) });
      },
      { signal },
    );
    this.keyboard.addEventListener("input", this.text, { signal });
    this.keyboard.addEventListener(
      "compositionstart",
      () => {
        this.composing = true;
      },
      { signal },
    );
    this.keyboard.addEventListener(
      "compositionend",
      () => {
        this.composing = false;
        this.text();
      },
      { signal },
    );
    this.keyboard.addEventListener("paste", (event) => event.stopPropagation(), { signal });
    this.keyboard.addEventListener("blur", this.release, { signal });
    window.addEventListener(
      "blur",
      () => {
        this.release();
        this.keyboard.blur();
      },
      { signal },
    );
  }

  private readonly text = () => {
    if (this.composing) return;

    if (this.keyboard.value) this.send({ type: "text", text: this.keyboard.value.slice(0, 8192) });
    this.keyboard.value = "";
  };

  active(next: boolean) {
    if (!next) {
      this.release();
      this.keyboard.blur();
    }

    this.enabled = next;
  }

  destroy() {
    this.release();
    this.abort.abort();
    this.keyboard.remove();
  }
}

export const bindDesktopHtmlInput = (
  surface: HTMLElement,
  canvas: HTMLCanvasElement,
  size: () => { width: number; height: number },
  command: (command: DesktopHtmlCommand) => void,
  onEscape: () => void,
) => new DesktopHtmlInputSession(surface, canvas, size, command, onEscape);
