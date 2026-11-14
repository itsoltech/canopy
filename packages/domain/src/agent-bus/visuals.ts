import { Result, Schema } from "effect";
import { VISUAL_LIMITS } from "../visuals/limits.ts";
import { decodeVisualSpec } from "../visuals/spec.ts";

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

export const RenderVisual = Schema.Struct({
  title: Text(VISUAL_LIMITS.titleChars),
  description: Text(VISUAL_LIMITS.descriptionChars).annotate({
    description: "What the visual shows, in plain words; also its text alternative.",
  }),
  height: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: VISUAL_LIMITS.minHeight, maximum: VISUAL_LIMITS.maxHeight })).annotate(
      {
        description: "Space to reserve in px (default 360). Taller content scrolls inside.",
      },
    ),
  ),
  spec: Schema.JsonObject.annotate({
    description:
      "Component tree: { schema_version: 1, state?: {key: initial value}, root: node }. See the tool description.",
  }),
  visual_id: Schema.optionalKey(
    Schema.String.check(Schema.isUUID()).annotate({
      description: "Update this visual of your thread to a new version.",
    }),
  ),
  expected_version: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: "Required with visual_id: the version you are replacing.",
    }),
  ),
});

const CATALOGUE =
  "Nodes (type + fields; text is plain, never HTML): stack{children,direction?:vertical|horizontal,gap?:xs|sm|md|lg,align?}, " +
  "grid{columns:1-4,children}, card{title?,subtitle?,tone?,children?}, divider, heading{text,level?:1-3}, " +
  "text{text,variant?:body|muted|small|strong}, code{text,label?}, list{items,ordered?}, badge{text,tone?}, " +
  "stat{label,value,detail?,tone?}, callout{text,title?,tone?}, table{columns(≤12),rows(≤100),caption?}, " +
  "button{label,variant?:primary|secondary|ghost,actions:[{action:set,state_key,value}|{action:next|previous|toggle,state_key}|{action:reset}] (≤8)}, " +
  "reset{label?}, tabs{state_key,tabs:[{value,label,children}]}, segmented{state_key,label,options:[string|{value,label}]}, " +
  "toggle{state_key,label}, stepper{state_key,steps:[{title,description?,children?}]}, when{state_key,equals,children}, " +
  "before_after{before:{label?,children},after:{label?,children}}, artboards{state_key,artboards:[{value,label,device?,children}]}, " +
  "device_frame{device:phone|tablet|desktop|browser,label?,children}, " +
  "button_preview{label,variant?|variant_from?:primary|secondary|outline|ghost|danger,size?|size_from?:sm|md|lg,disabled?|disabled_from?,loading?|loading_from?}, " +
  "flow{nodes:[{id,label,detail?,tone?,shape?:box|pill|diamond}](≤40),edges:[{from,to,label?}](≤80),direction?,highlight_from?}, " +
  "sequence{participants:[{id,label}](2-8),messages:[{from,to,label?,kind?:call|reply|note}],step_from?}, " +
  "chart{kind:bar|line,label,categories,series:[{name,values}](≤6, ≤200 points),unit?}. " +
  "tone: neutral|accent|info|success|warning|danger. ";

const STATE =
  "State: declare every key in state with its initial value: a string option, a boolean (toggle) or a step number " +
  "(stepper, 0-based). Option values come from the controls bound to the key. *_from and highlight_from/step_from read state. ";

const EXAMPLE =
  'Example: {"schema_version":1,"state":{"variant":"primary"},"root":{"type":"stack","children":[' +
  '{"type":"segmented","label":"Variant","state_key":"variant","options":["primary","secondary","ghost"]},' +
  '{"type":"button_preview","label":"Add worker","variant_from":"variant"}]}}. ';

export const VISUAL_TOOLS = {
  render_visual: {
    name: "render_visual",
    description:
      "Show the user an interactive visual in this thread, built from Canopy components: explanations, comparisons, " +
      "diagrams, step-by-step flows, button or layout variants, simple charts. Its controls change the visual locally; " +
      "they never contact you, run code or approve anything (use ask_user for decisions). No HTML, CSS, scripts, URLs or images. " +
      CATALOGUE +
      STATE +
      EXAMPLE +
      `Limits: spec ≤${VISUAL_LIMITS.specBytes / 1024} KiB, ≤${VISUAL_LIMITS.nodes} nodes, ≤${VISUAL_LIMITS.depth} levels, ` +
      `≤${VISUAL_LIMITS.perTurn} visuals per turn. Unknown fields are errors. Returns visual_id, item_id, version and citation_ref ` +
      "once saved. To change a visual, call again with visual_id and expected_version.",
    args: RenderVisual,
    mutates: true,
  },
} as const;

/** Arguments are checked against the spec limit before they are parsed (title and description add at most 8 KiB). */
export const RENDER_VISUAL_MAX_ARGUMENTS = VISUAL_LIMITS.specBytes + 8 * 1024;

/** Constraints the JSON Schema can't carry: the spec itself and paired update fields. */
export function renderVisualProblem(args: Schema.Schema.Type<typeof RenderVisual>): string | undefined {
  const spec = decodeVisualSpec(args.spec);

  if (Result.isFailure(spec)) return `spec: ${spec.failure}`;

  return (args.visual_id === undefined) !== (args.expected_version === undefined)
    ? "visual_id and expected_version go together"
    : undefined;
}
