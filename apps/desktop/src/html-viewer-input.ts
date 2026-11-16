import { Schema } from "effect";
import { HTML_DOCUMENT_BYTES } from "@canopy/domain/visual-html-source";
import { validVisualTheme } from "@canopy/domain/visuals";

export const ViewerInput = Schema.Struct({
  specJson: Schema.String.check(Schema.isMaxLength(HTML_DOCUMENT_BYTES * 6 + 64)),
  title: Schema.String.check(Schema.isMaxLength(200)),
});

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Integer = (min: number, max: number) => Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }));
const Color = Text(100);
export const ViewerId = Text(200).check(Schema.isMinLength(1));
export const ViewerWidth = Integer(1, 1600);
export const ViewerHeight = Integer(1, 1000);
export const VIEWER_FRAME_BYTES = 4 * 1024 * 1024;

export const ViewerTheme = Schema.Struct({
  mode: Schema.Literals(["light", "dark"]),
  scale: Schema.Number.check(Schema.isBetween({ minimum: 0.75, maximum: 1.5 })),
  colors: Schema.Struct({
    canvas: Color,
    surface: Color,
    panel: Color,
    hover: Color,
    ink: Color,
    muted: Color,
    border: Color,
    accent: Color,
    action: Color,
    "action-hover": Color,
    "on-accent": Color,
    info: Color,
    success: Color,
    warning: Color,
    danger: Color,
  }),
}).check(Schema.makeFilter(validVisualTheme));

export const ViewerStart = Schema.Struct({
  ...ViewerInput.fields,
  id: ViewerId,
  width: ViewerWidth,
  height: ViewerHeight,
  theme: Schema.optionalKey(ViewerTheme),
});

const Modifiers = Schema.optionalKey(
  Schema.Array(
    Schema.Literals(["shift", "control", "alt", "meta", "leftButtonDown", "middleButtonDown", "rightButtonDown"]),
  ).check(Schema.isMaxLength(7)),
);

const Pointer = { x: Integer(0, 1599), y: Integer(0, 999), modifiers: Modifiers };
const Delta = Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: -10000, maximum: 10000 }));

const Input = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Text(8192) }),
  Schema.Struct({
    type: Schema.Literals(["mouseMove", "mouseDown", "mouseUp"]),
    ...Pointer,
    button: Schema.optionalKey(Schema.Literals(["left", "middle", "right"])),
    clickCount: Schema.optionalKey(Integer(1, 3)),
  }),
  Schema.Struct({ type: Schema.Literal("mouseWheel"), ...Pointer, deltaX: Delta, deltaY: Delta }),
  Schema.Struct({
    type: Schema.Literals(["keyDown", "keyUp", "char"]),
    keyCode: Text(64).check(Schema.isMinLength(1)),
    modifiers: Modifiers,
  }),
]);

export const ViewerCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ack") }),
  Schema.Struct({ type: Schema.Literal("resize"), width: ViewerWidth, height: ViewerHeight }),
  Schema.Struct({ type: Schema.Literal("input"), event: Input }),
  Schema.Struct({
    type: Schema.Literal("host"),
    message: Schema.Union([
      Schema.Struct({ type: Schema.Literal("theme"), theme: ViewerTheme }),
      Schema.Struct({ type: Schema.Literal("visibility"), visible: Schema.Boolean }),
      Schema.Struct({ type: Schema.Literal("reduced_motion"), reduced: Schema.Boolean }),
      Schema.Struct({ type: Schema.Literal("reset") }),
    ]),
  }),
]);

/** Every message crossing the private child channel is decoded on receipt. */
export const ViewerRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("open"), ...ViewerInput.fields, theme: ViewerTheme }),
  Schema.Struct({ type: Schema.Literal("start"), ...ViewerStart.fields, theme: ViewerTheme }),
  Schema.Struct({ type: Schema.Literal("command"), command: ViewerCommand }),
]);

export const ViewerEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("frame"),
    width: ViewerWidth,
    height: ViewerHeight,
    png: Schema.Uint8Array.check(Schema.makeFilter((png) => png.byteLength <= VIEWER_FRAME_BYTES)),
  }),
  Schema.Struct({ type: Schema.Literal("height"), height: Integer(0, 1000000) }),
  Schema.Struct({ type: Schema.Literal("error"), message: Text(500) }),
  Schema.Struct({ type: Schema.Literal("escape") }),
]);

export const ViewerResponse = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["ready", "opened"]) }),
  ViewerEvent,
]);
