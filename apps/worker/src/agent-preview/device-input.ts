import type { AgentPreviewInput } from "@canopy/contracts";
import type { PreviewRuntime } from "./runtime.ts";
import { deviceKey } from "./device-keys.ts";

export class DeviceInput {
  readonly #runtime: PreviewRuntime;
  readonly #down = new Map<string, AgentPreviewInput>();
  width = 0;
  height = 0;

  constructor(runtime: PreviewRuntime) {
    this.#runtime = runtime;
  }

  release(owner: string): void {
    this.#down.delete(owner);
  }

  async input(input: AgentPreviewInput, owner: string): Promise<void> {
    if (input.kind === "release") return this.release(owner);

    if (!this.width || !this.height) throw new Error("Wait for the device preview frame before sending input");

    if (input.kind === "pointer-down") {
      if (input.button !== 0) throw new Error("Device gestures support the primary pointer only");
      this.#down.set(owner, input);

      return;
    }

    if (input.kind === "pointer-move" || input.kind === "key-up") return;

    if (input.kind === "pointer-up") {
      const down = this.#down.get(owner);
      this.#down.delete(owner);

      if (!down) throw new Error("Device pointer-up requires a matching pointer-down");
      const from = this.#point(down);
      const to = this.#point(input);
      const moved = Math.hypot(to.x - from.x, to.y - from.y) > 8;
      await this.#runtime.command(
        moved
          ? [
              "swipe",
              "--no-post-gesture-stabilization",
              "--",
              String(from.x),
              String(from.y),
              String(to.x),
              String(to.y),
            ]
          : ["click", "--", String(to.x), String(to.y)],
      );

      return;
    }

    if (input.kind === "wheel") {
      const vertical = Math.abs(input.deltaY) >= Math.abs(input.deltaX);
      const delta = vertical ? input.deltaY : input.deltaX;

      if (!delta) return;
      const direction = vertical ? (delta > 0 ? "down" : "up") : delta > 0 ? "right" : "left";
      await this.#runtime.command([
        "scroll",
        "--no-post-gesture-stabilization",
        "--pixels",
        String(Math.min(2000, Math.round(Math.abs(delta)))),
        "--",
        direction,
      ]);

      return;
    }

    if (input.kind === "text") {
      await this.#runtime.command(["type", "--", input.text]);

      return;
    }

    if (input.kind === "back" || input.kind === "home") {
      await this.#runtime.command([input.kind]);

      return;
    }

    if (input.kind === "key-down") {
      if (await deviceKey(this.#runtime, input)) return;

      if (["Alt", "Control", "Meta", "Shift"].includes(input.key)) return;

      if (input.modifiers) throw new Error("Device preview does not support modified keyboard shortcuts");

      if (input.key === "Enter") await this.#runtime.command(["keyboard", "enter"]);
      else if (input.key === "Escape") await this.#runtime.command(["back"]);
      else if (input.key === "Home") await this.#runtime.command(["home"]);
      else throw new Error("This device key is unsupported; use text, Enter, Back or Home");

      return;
    }

    throw new Error(`Device preview does not support ${input.kind}`);
  }

  #point(input: AgentPreviewInput) {
    return { x: Math.round(input.x * (this.width - 1)), y: Math.round(input.y * (this.height - 1)) };
  }
}
