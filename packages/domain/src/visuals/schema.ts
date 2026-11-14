import { Schema } from "effect";
import { VISUAL_LIMITS } from "./limits.ts";
import type { VisualNode, VisualSpec } from "./types.ts";

// Structural schema of spec v1. Unknown fields are rejected by decoding with onExcessProperty: "error"; limits that
// span the tree (nodes, depth, text, references) are checked in semantics.ts.

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const Label = Text(120);
const Body = Text(4000);
const optional = Schema.optionalKey;

const StateKey = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,31}$/));

const StateValue = Schema.Union([
  Text(64),
  Schema.Boolean,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 999 })),
]);

const Tone = Schema.Literals(["neutral", "accent", "info", "success", "warning", "danger"]);
const Gap = Schema.Literals(["xs", "sm", "md", "lg"]);
const Device = Schema.Literals(["phone", "tablet", "desktop", "browser"]);
const NodeId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,40}$/));

const Node: Schema.Codec<VisualNode> = Schema.suspend((): Schema.Codec<VisualNode> => VisualNodeSchema);
const Children = Schema.Array(Node).check(Schema.isMinLength(1), Schema.isMaxLength(VISUAL_LIMITS.nodes));
const Panel = Schema.Struct({ value: Text(64), label: Label, children: Children });

const Action = Schema.Union([
  Schema.Struct({ action: Schema.Literal("set"), state_key: StateKey, value: StateValue }),
  Schema.Struct({ action: Schema.Literals(["next", "previous", "toggle"]), state_key: StateKey }),
  Schema.Struct({ action: Schema.Literal("reset") }),
]);

const Edge = { from: NodeId, to: NodeId, label: optional(Text(200)) };

const layout = [
  Schema.Struct({
    type: Schema.Literal("stack"),
    direction: optional(Schema.Literals(["vertical", "horizontal"])),
    gap: optional(Gap),
    align: optional(Schema.Literals(["start", "center", "end", "stretch"])),
    children: Children,
  }),
  Schema.Struct({
    type: Schema.Literal("grid"),
    columns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
    gap: optional(Gap),
    children: Children,
  }),
  Schema.Struct({
    type: Schema.Literal("card"),
    title: optional(Label),
    subtitle: optional(Text(300)),
    tone: optional(Tone),
    children: optional(Children),
  }),
  Schema.Struct({ type: Schema.Literal("divider") }),
] as const;

const content = [
  Schema.Struct({
    type: Schema.Literal("heading"),
    text: Text(200),
    level: optional(Schema.Literals([1, 2, 3])),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Body,
    variant: optional(Schema.Literals(["body", "muted", "small", "strong"])),
  }),
  Schema.Struct({ type: Schema.Literal("code"), text: Body, label: optional(Label) }),
  Schema.Struct({
    type: Schema.Literal("list"),
    items: Schema.Array(
      Schema.Union([
        Text(500),
        Schema.Struct({
          label: Text(500),
          detail: optional(Text(500)),
          value: optional(Text(120)),
          tone: optional(Tone),
        }),
      ]),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
    ordered: optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("badge"), text: Text(60), tone: optional(Tone) }),
  Schema.Struct({
    type: Schema.Literal("stat"),
    label: Label,
    value: Text(60),
    detail: optional(Text(200)),
    tone: optional(Tone),
  }),
  Schema.Struct({ type: Schema.Literal("callout"), tone: optional(Tone), title: optional(Label), text: Body }),
  Schema.Struct({
    type: Schema.Literal("table"),
    columns: Schema.Array(Label).check(Schema.isMinLength(1), Schema.isMaxLength(VISUAL_LIMITS.tableColumns)),
    rows: Schema.Array(
      Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(VISUAL_LIMITS.tableColumns)),
    ).check(Schema.isMaxLength(VISUAL_LIMITS.tableRows)),
    caption: optional(Text(300)),
  }),
] as const;

const controls = [
  Schema.Struct({
    type: Schema.Literal("button"),
    label: Label,
    variant: optional(Schema.Literals(["primary", "secondary", "ghost"])),
    actions: Schema.Array(Action).check(Schema.isMinLength(1), Schema.isMaxLength(VISUAL_LIMITS.actionsPerButton)),
  }),
  Schema.Struct({ type: Schema.Literal("reset"), label: optional(Label) }),
  Schema.Struct({
    type: Schema.Literal("tabs"),
    state_key: StateKey,
    label: optional(Label),
    tabs: Schema.Array(Panel).check(Schema.isMinLength(2), Schema.isMaxLength(12)),
  }),
  Schema.Struct({
    type: Schema.Literal("segmented"),
    state_key: StateKey,
    label: Label,
    options: Schema.Array(Schema.Union([Text(64), Schema.Struct({ value: Text(64), label: Text(60) })])).check(
      Schema.isMinLength(2),
      Schema.isMaxLength(8),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("toggle"), state_key: StateKey, label: Label }),
  Schema.Struct({
    type: Schema.Literal("stepper"),
    state_key: StateKey,
    label: optional(Label),
    steps: Schema.Array(
      Schema.Struct({ title: Label, description: optional(Text(1000)), children: optional(Children) }),
    ).check(Schema.isMinLength(2), Schema.isMaxLength(20)),
  }),
  Schema.Struct({
    type: Schema.Literal("when"),
    state_key: StateKey,
    equals: Schema.Union([StateValue, Schema.Array(StateValue).check(Schema.isMinLength(1), Schema.isMaxLength(12))]),
    children: Children,
  }),
] as const;

const Side = Schema.Struct({ label: optional(Label), children: Children });

const comparisons = [
  Schema.Struct({ type: Schema.Literal("before_after"), before: Side, after: Side }),
  Schema.Struct({
    type: Schema.Literal("artboards"),
    state_key: StateKey,
    label: optional(Label),
    artboards: Schema.Array(
      Schema.Struct({ value: Text(64), label: Label, device: optional(Device), children: Children }),
    ).check(Schema.isMinLength(2), Schema.isMaxLength(12)),
  }),
  Schema.Struct({ type: Schema.Literal("device_frame"), device: Device, label: optional(Label), children: Children }),
  Schema.Struct({
    type: Schema.Literal("button_preview"),
    label: Text(60),
    variant: optional(Schema.Literals(["primary", "secondary", "outline", "ghost", "danger"])),
    variant_from: optional(StateKey),
    size: optional(Schema.Literals(["sm", "md", "lg"])),
    size_from: optional(StateKey),
    disabled: optional(Schema.Boolean),
    disabled_from: optional(StateKey),
    loading: optional(Schema.Boolean),
    loading_from: optional(StateKey),
  }),
] as const;

const diagrams = [
  Schema.Struct({
    type: Schema.Literal("flow"),
    direction: optional(Schema.Literals(["horizontal", "vertical"])),
    label: optional(Label),
    nodes: Schema.Array(
      Schema.Struct({
        id: NodeId,
        label: Label,
        detail: optional(Text(300)),
        tone: optional(Tone),
        shape: optional(Schema.Literals(["box", "pill", "diamond"])),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(VISUAL_LIMITS.diagramNodes)),
    edges: Schema.Array(Schema.Struct(Edge)).check(Schema.isMaxLength(VISUAL_LIMITS.diagramEdges)),
    highlight_from: optional(StateKey),
  }),
  Schema.Struct({
    type: Schema.Literal("sequence"),
    label: optional(Label),
    participants: Schema.Array(Schema.Struct({ id: NodeId, label: Label })).check(
      Schema.isMinLength(2),
      Schema.isMaxLength(8),
    ),
    messages: Schema.Array(
      Schema.Struct({ ...Edge, kind: optional(Schema.Literals(["call", "reply", "note"])) }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(VISUAL_LIMITS.diagramEdges)),
    step_from: optional(StateKey),
  }),
  Schema.Struct({
    type: Schema.Literal("chart"),
    kind: Schema.Literals(["bar", "line"]),
    label: Label,
    categories: Schema.Array(Text(60)).check(Schema.isMinLength(1), Schema.isMaxLength(VISUAL_LIMITS.chartPoints)),
    series: Schema.Array(
      Schema.Struct({ name: Text(60), values: Schema.Array(Schema.Finite).check(Schema.isMinLength(1)) }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(VISUAL_LIMITS.chartSeries)),
    unit: optional(Text(16)),
  }),
] as const;

const VisualNodeSchema: Schema.Codec<VisualNode> = Schema.Union([
  ...layout,
  ...content,
  ...controls,
  ...comparisons,
  ...diagrams,
]);

export const VisualSpecSchema: Schema.Codec<VisualSpec> = Schema.Struct({
  schema_version: Schema.Literal(1),
  state: optional(Schema.Record(StateKey, StateValue)),
  root: Node,
});
