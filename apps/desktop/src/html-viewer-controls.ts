import type { WebContents } from "electron";
import { Schema, Result } from "effect";
import type { DesktopHtmlInput, DesktopHtmlModifier } from "@canopy/ui/desktop";

const Attachment = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMaxLength(128)),
  targetInfo: Schema.Struct({ type: Schema.Literal("iframe") }),
});

const keyAliases = new Map([
  ["Left", "ArrowLeft"],
  ["Right", "ArrowRight"],
  ["Up", "ArrowUp"],
  ["Down", "ArrowDown"],
  ["Space", " "],
]);

const virtualKeys = new Map([
  ["Backspace", 8],
  ["Tab", 9],
  ["Enter", 13],
  ["Shift", 16],
  ["Control", 17],
  ["Alt", 18],
  ["Escape", 27],
  [" ", 32],
  ["PageUp", 33],
  ["PageDown", 34],
  ["End", 35],
  ["Home", 36],
  ["ArrowLeft", 37],
  ["ArrowUp", 38],
  ["ArrowRight", 39],
  ["ArrowDown", 40],
  ["Insert", 45],
  ["Delete", 46],
  ["Meta", 91],
]);

function modifierBits(modifiers: readonly DesktopHtmlModifier[] = []) {
  let keys = 0;
  let buttons = 0;

  for (const modifier of modifiers) {
    switch (modifier) {
      case "alt":
        keys |= 1;
        break;
      case "control":
        keys |= 2;
        break;
      case "meta":
        keys |= 4;
        break;
      case "shift":
        keys |= 8;
        break;
      case "leftButtonDown":
        buttons |= 1;
        break;
      case "rightButtonDown":
        buttons |= 2;
        break;
      case "middleButtonDown":
        buttons |= 4;
        break;
    }
  }

  return { keys, buttons };
}

function keyEvent(input: Extract<DesktopHtmlInput, { keyCode: string }>) {
  const key = keyAliases.get(input.keyCode) ?? input.keyCode;
  let virtualKey = virtualKeys.get(key) ?? 0;

  if (key.length === 1) virtualKey = key.toUpperCase().charCodeAt(0);
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);

  if (functionKey) virtualKey = 111 + Number(functionKey[1]);

  return {
    type: input.type,
    key,
    code: physicalCode(key),
    windowsVirtualKeyCode: virtualKey,
    modifiers: modifierBits(input.modifiers).keys,
    text: input.type === "char" ? input.keyCode : input.type === "keyDown" && key === "Enter" ? "\r" : "",
  };
}

function physicalCode(key: string) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;

  if (/^[0-9]$/.test(key)) return `Digit${key}`;

  if (key === " ") return "Space";

  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return `${key}Left`;

  return key.length > 1 ? key : "";
}

/** Hidden offscreen windows cannot receive native focus. Route bounded input to their opaque OOPIF. */
export class ViewerControls {
  private session = "";
  private buttons = 0;
  private disposed = false;

  constructor(
    private readonly contents: WebContents,
    private readonly fail: (message: string) => void,
  ) {
    contents.debugger.attach("1.3");
    contents.debugger.on("detach", () => {
      setImmediate(() => {
        if (!this.disposed && !contents.isDestroyed()) fail("This visual stopped responding.");
      });
    });
    contents.debugger.on("message", (_event, method, parameters) => {
      if (method !== "Target.attachedToTarget" || this.session) return;
      const attachment = Schema.decodeUnknownResult(Attachment)(parameters);

      if (Result.isFailure(attachment)) return;
      // The shell creates its sole iframe before any agent code can create descendants.
      this.session = attachment.success.sessionId;
      void contents.debugger
        .sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }, this.session)
        .catch(() => fail("Couldn't focus this visual."));
    });
    void contents.debugger
      .sendCommand("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => fail("Couldn't control this visual."));
  }

  send(input: DesktopHtmlInput) {
    if (this.disposed || !this.session || this.contents.isDestroyed()) return;

    if (input.type === "text") {
      void this.contents.debugger
        .sendCommand("Input.insertText", { text: input.text }, this.session)
        .catch(() => this.fail("Couldn't enter text in this visual."));

      return;
    }

    if ("keyCode" in input) {
      void this.contents.debugger
        .sendCommand("Input.dispatchKeyEvent", keyEvent(input), this.session)
        .catch(() => this.fail("Couldn't control this visual."));

      return;
    }

    const bits = modifierBits(input.modifiers);
    const wheel = input.type === "mouseWheel";
    let type = "mouseMoved";

    if (input.type === "mouseDown") type = "mousePressed";

    if (input.type === "mouseUp") type = "mouseReleased";

    if (wheel) type = "mouseWheel";

    const button = "button" in input ? (input.button ?? "left") : "none";
    const buttonBit = button === "left" ? 1 : button === "right" ? 2 : button === "middle" ? 4 : 0;

    if (input.type === "mouseDown") this.buttons |= buttonBit;

    if (input.type === "mouseUp") this.buttons &= ~buttonBit;

    const pointer = {
      type,
      x: input.x,
      y: input.y,
      modifiers: bits.keys,
      buttons: this.buttons | bits.buttons,
      button,
      clickCount: "clickCount" in input ? (input.clickCount ?? 1) : 0,
    };

    const parameters = wheel ? { ...pointer, deltaX: -input.deltaX, deltaY: -input.deltaY } : pointer;

    void this.contents.debugger
      .sendCommand("Input.dispatchMouseEvent", parameters, this.session)
      .catch(() => this.fail("Couldn't control this visual."));
  }

  dispose() {
    this.disposed = true;

    if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) this.contents.debugger.detach();
  }
}
