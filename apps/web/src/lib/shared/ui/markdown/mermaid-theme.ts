import type { MermaidConfig } from "mermaid";
import type { VisualTheme } from "@canopy/domain/visuals";

/** The colours one diagram is drawn with, all `#rrggbb`. */
interface Palette {
  dark: boolean;
  ink: string;
  muted: string;
  border: string;
  accent: string;
  onAccent: string;
  /** The code frame's wash behind the diagram. */
  canvas: string;
  /** Nodes, actors and states: cards like the visual kit's flow nodes. */
  node: string;
  /** Subgraphs, composite states, activations: a shade on the canvas. */
  group: string;
  line: string;
  note: string;
  noteBorder: string;
  series: string[];
}

let context: CanvasRenderingContext2D | null | undefined;

/**
 * A CSS colour as `#rrggbb`: Mermaid derives shades from its colours and only reads hex/rgb/hsl. The colour is
 * painted on one pixel and read back, so `color-mix()` and `oklab()` come out as sRGB.
 */
function solid(css: string, fallback: string): string {
  context ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });

  if (!context) return fallback;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = fallback;
  context.fillStyle = css;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;

  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** `amount` of `tint` over `base`, mixed like the app's `color-mix(in oklab, …)`. */
const mix = (base: string, tint: string, amount: number) =>
  solid(`color-mix(in oklab, ${tint} ${Math.round(amount * 100)}%, ${base})`, base);

function palette({ mode, colors }: VisualTheme): Palette {
  const dark = mode === "dark";
  // CodeFrame's wash: zinc-950 at 2.5 %, white at 5 % in dark.
  const canvas = mix(colors.surface, dark ? "#ffffff" : "#09090b", dark ? 0.05 : 0.025);
  const node = dark ? mix(colors.panel, colors.hover, 0.6) : colors.surface;
  const hues = [colors.accent, colors.info, colors.success, colors.warning, colors.danger, colors.muted];

  return {
    dark,
    ink: colors.ink,
    muted: colors.muted,
    border: colors.border,
    accent: colors.accent,
    onAccent: colors["on-accent"],
    canvas,
    node,
    group: mix(canvas, colors.ink, dark ? 0.035 : 0.03),
    line: mix(colors.muted, canvas, 0.25),
    note: mix(node, colors.accent, dark ? 0.16 : 0.08),
    noteBorder: mix(colors.border, colors.accent, 0.45),
    series: hues.map((hue) => solid(hue, colors.accent)),
  };
}

/** Canopy's look for Mermaid: card nodes, quiet lines, 13 px text, the accent only on notes and charts. */
export function mermaidAppearance(theme: VisualTheme): MermaidConfig {
  const colors = palette(theme);
  const fontFamily = getComputedStyle(document.body).fontFamily;

  return {
    fontFamily,
    fontSize: 13,
    look: "classic",
    themeCSS: css(colors),
    flowchart: { padding: 12, nodeSpacing: 36, rankSpacing: 44 },
    sequence: { actorFontWeight: 500, noteFontSize: 12, mirrorActors: false, boxMargin: 8, noteMargin: 8 },
    pie: { textPosition: 0.7 },
    themeVariables: { ...base(colors), fontFamily, ...diagrams(colors), ...charts(colors) },
  };
}

function base(colors: Palette) {
  const { ink, muted, border, canvas, node, group, line } = colors;

  return {
    darkMode: colors.dark,
    fontSize: "13px",
    radius: 8,
    strokeWidth: 1,
    dropShadow: "none",
    useGradient: false,
    background: canvas,
    mainBkg: node,
    nodeBkg: node,
    primaryColor: node,
    primaryTextColor: ink,
    primaryBorderColor: border,
    secondaryColor: group,
    secondaryTextColor: ink,
    secondaryBorderColor: border,
    tertiaryColor: group,
    tertiaryTextColor: ink,
    tertiaryBorderColor: border,
    nodeBorder: border,
    nodeTextColor: ink,
    clusterBkg: group,
    clusterBorder: border,
    titleColor: muted,
    textColor: ink,
    lineColor: line,
    arrowheadColor: line,
    defaultLinkColor: line,
    edgeLabelBackground: canvas,
    labelBackgroundColor: canvas,
    noteBkgColor: colors.note,
    noteTextColor: ink,
    noteBorderColor: colors.noteBorder,
  };
}

/** Sequence, state, class and ER diagrams. */
function diagrams(colors: Palette) {
  const { ink, muted, border, canvas, node, group, line } = colors;

  return {
    actorBkg: node,
    actorBorder: border,
    actorTextColor: ink,
    actorLineColor: border,
    signalColor: line,
    signalTextColor: ink,
    labelBoxBkgColor: node,
    labelBoxBorderColor: border,
    labelTextColor: ink,
    loopTextColor: muted,
    activationBkgColor: group,
    activationBorderColor: border,
    sequenceNumberColor: colors.onAccent,
    stateBkg: node,
    stateBorder: border,
    stateLabelColor: ink,
    compositeBackground: group,
    compositeTitleBackground: group,
    compositeBorder: border,
    altBackground: group,
    transitionColor: line,
    transitionLabelColor: muted,
    specialStateColor: muted,
    innerEndBackground: muted,
    classText: ink,
    relationColor: line,
    relationLabelColor: muted,
    relationLabelBackground: canvas,
    rowOdd: node,
    rowEven: group,
    attributeBackgroundColorOdd: node,
    attributeBackgroundColorEven: group,
  };
}

/** Pie charts and the colour scale of mind maps, timelines and journeys. */
function charts(colors: Palette) {
  const { dark, ink, border, canvas, node, series } = colors;

  // Mermaid's colour scale has 12 steps: the hues repeat, tinted on the card colour, their line in the full hue.
  const scale = Array.from({ length: 12 }, (_, index) => {
    const hue = series[index % series.length] ?? colors.accent;

    return [
      [`cScale${index}`, mix(node, hue, dark ? 0.3 : 0.16)],
      [`cScaleInv${index}`, hue],
      [`cScaleLabel${index}`, ink],
    ];
  });

  return {
    ...Object.fromEntries(series.map((hue, index) => [`pie${index + 1}`, hue])),
    ...Object.fromEntries(scale.flat()),
    git0: colors.accent,
    gitBranchLabel0: dark ? canvas : colors.onAccent,
    scaleLabelColor: ink,
    pieTitleTextColor: ink,
    pieSectionTextColor: dark ? canvas : "#ffffff",
    pieLegendTextColor: ink,
    pieStrokeColor: canvas,
    pieStrokeWidth: "2px",
    pieOuterStrokeColor: border,
    pieOuterStrokeWidth: "1px",
    pieOpacity: "1",
  };
}

/** Details the variables do not reach. Mermaid scopes these rules to the diagram's own id. */
function css({ muted, border, canvas, group, line }: Palette): string {
  return `
    .node rect, .node polygon, .node circle, .node ellipse, .node path { stroke-width: 1px; }
    .node rect.label-container, .actor { rx: 8px; ry: 8px; }
    .cluster rect { rx: 12px; ry: 12px; fill: ${group}; stroke: ${border}; }
    .cluster-label, .cluster-label span, .cluster-label p { color: ${muted}; fill: ${muted}; }
    .edgeLabel, .edgeLabel p, .edgeLabel span, .edgeLabel rect { color: ${muted}; font-size: 12px; }
    .flowchart-link, .edgePath .path, .transition, .relation { stroke: ${line}; stroke-width: 1.25px; }
    .marker, marker path { fill: ${line}; stroke: ${line}; }
    marker circle { fill: ${canvas}; stroke: ${line}; }
    .actor { stroke-width: 1px; }
    .messageLine0, .messageLine1 { stroke-width: 1.25px; }
    .note { rx: 6px; ry: 6px; }
    .sequenceNumber { font-size: 10px; font-weight: 600; }
    .loopLine { stroke: ${border}; stroke-dasharray: 3 3; }
    .labelBox { rx: 4px; ry: 4px; }
    .pieTitleText, .titleText { font-size: 14px; font-weight: 600; }
    .slice { font-size: 12px; font-weight: 500; }
    .legend text { font-size: 12px; }
  `;
}
