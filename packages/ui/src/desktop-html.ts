/** Palette-only contract: structurally compatible with the domain visual theme. */
export interface DesktopHtmlTheme {
  readonly mode: "light" | "dark";
  readonly scale: number;
  readonly colors: Readonly<
    Record<
      | "canvas"
      | "surface"
      | "panel"
      | "hover"
      | "ink"
      | "muted"
      | "border"
      | "accent"
      | "action"
      | "action-hover"
      | "on-accent"
      | "info"
      | "success"
      | "warning"
      | "danger",
      string
    >
  >;
}

export interface DesktopHtmlStart {
  /** Unique per mount; events and commands belong to the invoking application window. */
  readonly id: string;
  readonly specJson: string;
  readonly title: string;
  /** Integer CSS pixels: width 1–1600, height 1–1000. */
  readonly width: number;
  readonly height: number;
  readonly theme?: DesktopHtmlTheme;
}

export type DesktopHtmlModifier =
  | "shift"
  | "control"
  | "alt"
  | "meta"
  | "leftButtonDown"
  | "middleButtonDown"
  | "rightButtonDown";

export type DesktopHtmlInput = (
  | {
      readonly type: "mouseMove" | "mouseDown" | "mouseUp";
      readonly x: number;
      readonly y: number;
      readonly button?: "left" | "middle" | "right";
      readonly clickCount?: number;
    }
  | {
      readonly type: "mouseWheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | { readonly type: "keyDown" | "keyUp" | "char"; readonly keyCode: string }
  /** One committed text/composition or paste batch, at most 8192 UTF-16 code units. */
  | { readonly type: "text"; readonly text: string }
) & { readonly modifiers?: readonly DesktopHtmlModifier[] };

export type DesktopHtmlHostMessage =
  | { readonly type: "theme"; readonly theme: DesktopHtmlTheme }
  | { readonly type: "visibility"; readonly visible: boolean }
  | { readonly type: "reduced_motion"; readonly reduced: boolean }
  | { readonly type: "reset" };

export type DesktopHtmlCommand =
  /** Acknowledge each consumed frame; at most one PNG is in flight. */
  | { readonly type: "ack" }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "host"; readonly message: DesktopHtmlHostMessage }
  | { readonly type: "input"; readonly event: DesktopHtmlInput };

export type DesktopHtmlEvent = { readonly id: string } & (
  | { readonly type: "frame"; readonly png: Uint8Array; readonly width: number; readonly height: number }
  | { readonly type: "height"; readonly height: number }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "escape" }
  | { readonly type: "replaced" }
);
