import { activityNotchFloatingMargin } from "./activity-notch-geometry.ts";

const edgeTransition = (duration: string, easing: string, delay = "0s") =>
  ["--x", "--y", "--w", "--h"].map((property) => `${property} ${duration} ${easing} ${delay}`).join(", ");

/** Each docked side puts its ears where the outline meets the screen edge: away from both the edge and the outline. */
const ears = {
  top: [
    ["calc(var(--x) - var(--ear))", "var(--y)", "0% 100%"],
    ["calc(var(--x) + var(--w))", "var(--y)", "100% 100%"],
  ],
  bottom: [
    ["calc(var(--x) - var(--ear))", "calc(var(--y) + var(--h) - var(--ear))", "0% 0%"],
    ["calc(var(--x) + var(--w))", "calc(var(--y) + var(--h) - var(--ear))", "100% 0%"],
  ],
  right: [
    ["calc(var(--x) + var(--w) - var(--ear))", "calc(var(--y) - var(--ear))", "0% 0%"],
    ["calc(var(--x) + var(--w) - var(--ear))", "calc(var(--y) + var(--h))", "0% 100%"],
  ],
  left: [
    ["var(--x)", "calc(var(--y) - var(--ear))", "100% 0%"],
    ["var(--x)", "calc(var(--y) + var(--h))", "100% 100%"],
  ],
};

const earRules = Object.entries(ears)
  .flatMap(([side, pair]) =>
    pair.map(
      ([left, top, corner], index) =>
        `[data-side="${side}"] .ear-${index ? "end" : "start"} { left: ${left}; top: ${top}; --corner: ${corner}; }`,
    ),
  )
  .join("\n  ");

/** The corners on the screen edge stay square; the others round, more once the outline opens. */
const corners = {
  top: "0 0 var(--r) var(--r)",
  bottom: "var(--r) var(--r) 0 0",
  right: "var(--r) 0 0 var(--r)",
  left: "0 var(--r) var(--r) 0",
  float: "var(--r)",
};

const cornerRules = Object.entries(corners)
  .map(([side, value]) => `[data-side="${side}"] .notch-body { border-radius: ${value}; }`)
  .join("\n  ");

/** A floating pill casts a shadow; the window keeps a margin around it so the shadow is not cut. */
const shadow = (lift: number) =>
  `0 0 0 1px color-mix(in srgb, var(--ink) 12%, transparent), 0 ${lift}px ${activityNotchFloatingMargin - lift + 8}px -8px rgb(0 0 0 / 0.6)`;

/**
 * The outline is drawn anywhere in its window from four animated lengths. The list keeps its own place, so the
 * moving outline clips it instead of reflowing its titles; the ears and the header follow the outline's edges.
 */
export const activityNotchOutlineStyles = `
  @property --x { syntax: "<length>"; inherits: true; initial-value: 0px; }
  @property --y { syntax: "<length>"; inherits: true; initial-value: 0px; }
  @property --w { syntax: "<length>"; inherits: true; initial-value: 0px; }
  @property --h { syntax: "<length>"; inherits: true; initial-value: 0px; }
  .notch {
    position: fixed;
    inset: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--fade-duration) var(--ease-smooth-out);
  }
  .notch:not([data-layout]) { visibility: hidden; }
  .notch[data-active] { opacity: 1; }
  .notch[data-animate] {
    transition: ${edgeTransition("var(--morph-open-dur)", "var(--morph-ease)")},
      opacity var(--fade-duration) var(--ease-smooth-out);
  }
  .notch[data-animate][data-shrinking] {
    transition: ${edgeTransition("var(--morph-close-dur)", "var(--morph-close-ease)", "var(--morph-close-delay)")},
      opacity var(--fade-duration) var(--ease-smooth-out);
  }
  .ear {
    position: absolute;
    width: var(--ear);
    height: var(--ear);
    background: #000;
    mask-image: radial-gradient(circle at var(--corner), transparent calc(var(--ear) - 0.5px), #000 var(--ear));
  }
  ${earRules}
  [data-side="float"] .ear { display: none; }
  .notch-body {
    --r: var(--notch-radius);
    position: absolute;
    left: var(--x);
    top: var(--y);
    width: var(--w);
    height: var(--h);
    overflow: hidden;
    background: #000;
    color-scheme: dark;
    pointer-events: auto;
  }
  ${cornerRules}
  [data-open="true"] .notch-body { --r: var(--notch-open-radius); }
  [data-side="float"][data-open="false"] .notch-body { --r: calc(var(--header) / 2); }
  [data-side="float"] .notch-body {
    box-shadow: ${shadow(6)};
    transition: box-shadow var(--press-dur) var(--ease-smooth-out);
  }
  [data-side="float"][data-dragging] .notch-body { box-shadow: ${shadow(10)}; }
  [data-animate] .notch-body {
    transition:
      border-radius var(--morph-open-dur) var(--morph-ease),
      box-shadow var(--press-dur) var(--ease-smooth-out);
  }
  [data-animate][data-shrinking] .notch-body {
    transition:
      border-radius var(--morph-close-dur) var(--morph-close-ease) var(--morph-close-delay),
      box-shadow var(--press-dur) var(--ease-smooth-out);
  }
  .notch-toggle {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: var(--header);
    padding: 0;
    border-radius: inherit;
  }
  [data-header="end"] .notch-toggle { top: auto; bottom: 0; }
  [data-open="true"] .notch-toggle { border-radius: 0; }
  [data-dragging] .notch-toggle { cursor: grabbing; }
  /* The wings sit at the ends of the header; on a side edge the closed tab stacks the icon over the count. */
  .wing {
    position: absolute;
    top: 0;
    width: var(--wing);
    height: var(--header);
  }
  .summary { left: 0; }
  .count { right: 0; }
  [data-side="float"] .summary { left: var(--grip); }
  [data-vertical] .notch-toggle { height: 100%; }
  [data-vertical] .wing { width: 100%; height: var(--wing); }
  [data-vertical] .count { top: auto; bottom: 0; }
  .grip { display: none; }
  [data-side="float"] .grip {
    position: absolute;
    top: calc(var(--header) / 2 - 5px);
    left: 5px;
    display: block;
    width: 7px;
    height: 11px;
    background: radial-gradient(circle, var(--muted) 0.9px, transparent 1.25px) 0 0 / 4px 4px;
    opacity: 0.7;
  }
  .panel {
    position: absolute;
    top: calc(var(--list-y) - var(--y));
    left: calc(var(--list-x) - var(--x));
    width: var(--list-w);
    transform-origin: var(--origin-x) var(--origin-y);
  }
  @media (prefers-reduced-motion: reduce) {
    .notch, .notch[data-animate], .notch[data-animate][data-shrinking], .notch-body, [data-animate] .notch-body,
    [data-animate][data-shrinking] .notch-body {
      transition: none;
    }
  }
`;
