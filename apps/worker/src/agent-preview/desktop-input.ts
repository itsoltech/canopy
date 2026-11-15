import type { AgentPreviewInput } from "@canopy/contracts";
import { z } from "zod";
import type { PreviewRuntime } from "./runtime.ts";
import type { DesktopCatalog } from "./catalog.ts";

const BUTTONS = ["left", "middle", "right"];

const MODIFIERS = [
  [1, "alt"],
  [2, "ctrl"],
  [4, "meta"],
  [8, "shift"],
] as const;

const KEYS = new Map(
  Object.entries({
    Enter: "return",
    Escape: "escape",
    Backspace: "backspace",
    Delete: "delete",
    Tab: "tab",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    PageUp: "pageup",
    PageDown: "pagedown",
    Home: "home",
    End: "end",
    " ": "space",
  }),
);

const MODIFIER_KEYS = new Set(["Control", "Alt", "Meta", "Shift"]);
const focused = z.object({ match: z.object({ ref_id: z.string().regex(/^@[^\s:]+:e\d+$/) }).nullable() });

export class DesktopInput {
  readonly #runtime: PreviewRuntime;
  readonly #catalog: DesktopCatalog;
  readonly #down = new Map<string, AgentPreviewInput>();

  constructor(runtime: PreviewRuntime, catalog: DesktopCatalog) {
    this.#runtime = runtime;
    this.#catalog = catalog;
  }

  release(owner: string): void {
    this.#down.delete(owner);
  }

  async input(input: AgentPreviewInput, owner: string): Promise<void> {
    if (input.kind === "release") return this.release(owner);

    if (!this.#catalog.selected) throw new Error("Select an accessible window before sending input");

    if (input.kind === "pointer-down") {
      if (this.#down.has(owner)) throw new Error("A desktop pointer gesture is already in progress");
      this.#down.set(owner, input);

      return;
    }

    if (input.kind === "pointer-up") return this.#pointerUp(input, owner);

    if (input.kind === "pointer-move") {
      if (this.#down.has(owner)) return;
      const point = this.#catalog.point(input.x, input.y);
      await this.#runtime.command(["mouse-move", `--xy=${point.x},${point.y}`]);

      return;
    }

    if (input.kind === "wheel") {
      const point = this.#catalog.point(input.x, input.y);
      await this.#runtime.command([
        "mouse-wheel",
        `--x=${point.x}`,
        `--y=${point.y}`,
        `--dx=${input.deltaX / 40}`,
        `--dy=${-input.deltaY / 40}`,
        ...this.#modifiers(input.modifiers),
      ]);

      return;
    }

    if (input.kind === "key-up" || (input.kind === "key-down" && MODIFIER_KEYS.has(input.key))) return;

    if (input.kind === "key-down") {
      const key =
        KEYS.get(input.key) ??
        (/^[a-zA-Z0-9]$|^F(?:[1-9]|1[0-9]|2[0-4])$/.test(input.key) ? input.key.toLowerCase() : "");

      if (!key) throw new Error("This desktop key is unsupported; send printable characters as text");
      const combo = [...MODIFIERS.flatMap(([bit, name]) => (input.modifiers & bit ? [name] : [])), key].join("+");
      await this.#runtime.command(["press", ...this.#catalog.scopeArgs(), "--", combo]);

      return;
    }

    if (input.kind === "text") {
      const found = focused.parse(
        await this.#runtime.command(["find", ...this.#catalog.scopeArgs(), "--state", "focused", "--first"]),
      );

      if (!found.match) throw new Error("No focused text field was found in the selected window");
      await this.#runtime.command(["type", "--stdin", "--", found.match.ref_id], { input: input.text });

      return;
    }

    throw new Error(`Desktop preview does not support ${input.kind}`);
  }

  #modifiers(mask: number): string[] {
    return MODIFIERS.filter(([bit]) => mask & bit).flatMap(([, name]) => ["--modifiers", name]);
  }

  async #pointerUp(input: AgentPreviewInput, owner: string): Promise<void> {
    const down = this.#down.get(owner);
    this.#down.delete(owner);

    if (!down) throw new Error("Desktop pointer-up requires a matching pointer-down");
    await this.#catalog.refresh();
    const from = this.#catalog.point(down.x, down.y);
    const to = this.#catalog.point(input.x, input.y);
    const moved = Math.hypot(to.x - from.x, to.y - from.y) > 4;

    if (moved && down.button !== 0) throw new Error("Desktop drag supports the primary button only");
    await this.#runtime.command(
      moved
        ? ["drag", `--from-xy=${from.x},${from.y}`, `--to-xy=${to.x},${to.y}`, "--duration", "250"]
        : [
            "mouse-click",
            `--xy=${to.x},${to.y}`,
            "--button",
            BUTTONS[down.button]!,
            ...this.#modifiers(down.modifiers),
          ],
    );
  }
}
