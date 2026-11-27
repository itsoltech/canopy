import { motion, palette, radius } from "@canopy/ui";
import { interfaceFonts } from "@canopy/ui/fonts";
import { workingColors } from "@canopy/ui/thread-row";
import { themeVariables } from "@canopy/ui/themes";
import {
  activityNotchBottomInset,
  activityNotchEarWidth,
  activityNotchRowHeight,
  activityNotchSimulatedHeight,
  activityNotchVisibleRows,
  activityNotchWingWidth,
} from "./activity-notch-geometry.ts";

const colors = themeVariables("ash", "dark");
const ease = (points: readonly number[]) => `cubic-bezier(${points.join(", ")})`;

/** A row added below the visible list waits until the growing outline has room for it. */
export const activityNotchPanelDelay = motion.micro * 2;

export const activityNotchStyles = `
  @property --notch-width {
    syntax: "<length>";
    inherits: false;
    initial-value: 0px;
  }
  :root {
    --ear: ${activityNotchEarWidth}px;
    --wing: ${activityNotchWingWidth}px;
    --row-height: ${activityNotchRowHeight}px;
    --bottom-inset: ${activityNotchBottomInset}px;
    --type-compact: 0.8125rem;
    --type-meta: 0.71875rem;
    --radius-md: ${radius.md}px;
    --notch-radius: ${radius.xl}px;
    --notch-open-radius: ${radius.bubble}px;
    --ink: ${colors.ink};
    --muted: ${colors.muted};
    --border: ${colors.border};
    /* The outline grows without overshoot: the native window ends exactly at its open size. */
    --morph-open-dur: ${motion.medium}ms;
    --morph-close-dur: ${motion.fast}ms;
    --morph-ease: ${ease(motion.smoothOut)};
    /* A short hold and a soft start let the list fade before either edge reaches a row. */
    --morph-close-delay: ${motion.stagger}ms;
    --morph-close-ease: ${ease(motion.inOut)};
    /* The first row starts once the outline covers it; the stagger keeps later rows behind the edge. */
    --panel-enter-delay: ${motion.micro}ms;
    --panel-exit-dur: ${motion.micro}ms;
    --panel-scale: ${motion.scale.medium};
    --panel-blur: 4px;
    --row-enter-dur: ${motion.fast}ms;
    --row-enter-blur: 4px;
    --row-enter-distance: ${motion.distance.small}px;
    --stagger: ${motion.stagger}ms;
    --swap-blur: 4px;
    --wing-enter-dur: ${motion.slow}ms;
    --wing-enter-delay: ${motion.stagger}ms;
    --wing-start-scale: 0.5;
    --fade-duration: ${motion.quick}ms;
    --press-dur: ${motion.quick}ms;
    --spin-duration: ${motion.spin}ms;
    --count-in-dur: ${motion.slow}ms;
    --count-out-dur: ${motion.quick}ms;
    --count-overlap: ${motion.stagger}ms;
    --count-distance: 0.5em;
    --count-lift: -0.06em;
    --count-start-scale: 0.7;
    --count-peak: 1.08;
    --count-blur: 3px;
    --ease-smooth-out: ${ease(motion.smoothOut)};
    --ease-in-out: ${ease(motion.inOut)};
    /* Settles just past its target: only for small marks that have room to overshoot inside the notch. */
    --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    overflow: hidden;
    color: var(--ink);
    font: var(--type-compact) / 1.25rem ${interfaceFonts[0]?.stack ?? "system-ui, sans-serif"};
    -webkit-font-smoothing: antialiased;
    user-select: none;
  }
  button {
    appearance: none;
    border: 0;
    color: inherit;
    background: none;
    font: inherit;
  }
  button:focus-visible {
    outline: 2px solid ${palette.sky[400]};
    outline-offset: -3px;
  }
  .notch {
    position: relative;
    opacity: 0;
    --notch-height: ${activityNotchSimulatedHeight}px;
    --open-width: 100vw;
    /* Where the outline starts now and where it starts once open, from the left of the window. */
    --notch-offset: clamp(0px, var(--notch-center, 50vw) - var(--notch-width) / 2, 100vw - var(--notch-width));
    --open-offset: clamp(0px, var(--notch-center, 50vw) - var(--open-width) / 2, 100vw - var(--open-width));
    width: max(0px, calc(var(--notch-width) - 2 * var(--ear)));
    margin-left: calc(var(--ear) + var(--notch-offset));
    transition: opacity var(--fade-duration) var(--ease-smooth-out);
  }
  .notch:not([data-layout]) { visibility: hidden; }
  .notch[data-active] { opacity: 1; }
  .notch[data-animate] {
    transition:
      --notch-width var(--morph-open-dur) var(--morph-ease),
      opacity var(--fade-duration) var(--ease-smooth-out);
  }
  .notch[data-animate][data-shrinking] {
    transition:
      --notch-width var(--morph-close-dur) var(--morph-close-ease) var(--morph-close-delay),
      opacity var(--fade-duration) var(--ease-smooth-out);
  }
  .notch::before, .notch::after {
    position: absolute;
    top: 0;
    width: var(--ear);
    height: var(--ear);
    background: #000;
    mask-image: radial-gradient(circle at var(--outer) 100%, transparent calc(var(--ear) - 0.5px), #000 var(--ear));
    pointer-events: none;
    content: "";
  }
  .notch::before {
    right: 100%;
    --outer: 0%;
  }
  .notch::after {
    left: 100%;
    --outer: 100%;
  }
  .notch-body {
    height: var(--notch-size, var(--notch-height));
    overflow: hidden;
    border-radius: 0 0 var(--notch-radius) var(--notch-radius);
    background: #000;
    color-scheme: dark;
  }
  [data-open="true"] .notch-body { border-radius: 0 0 var(--notch-open-radius) var(--notch-open-radius); }
  [data-animate] .notch-body {
    transition:
      height var(--morph-open-dur) var(--morph-ease),
      border-radius var(--morph-open-dur) var(--morph-ease);
  }
  [data-animate][data-shrinking] .notch-body {
    transition:
      height var(--morph-close-dur) var(--morph-close-ease) var(--morph-close-delay),
      border-radius var(--morph-close-dur) var(--morph-close-ease) var(--morph-close-delay);
  }
  .notch-toggle {
    display: grid;
    grid-template-columns: var(--wing) minmax(0, 1fr) var(--wing);
    align-items: center;
    width: 100%;
    height: var(--notch-height);
    padding: 0;
    border-radius: inherit;
  }
  [data-open="true"] .notch-toggle { border-radius: 0; }
  .rows {
    max-height: max(0px, min(${activityNotchVisibleRows * activityNotchRowHeight}px, calc(100dvh - var(--notch-height) - var(--bottom-inset))));
    margin: 0 var(--bottom-inset) var(--bottom-inset);
    padding: 0;
    overflow: auto;
    overscroll-behavior: contain;
    /* No reserved gutter: the rows keep the same inset on the sides as at the bottom. */
    scrollbar-color: var(--border) transparent;
    scrollbar-width: thin;
    list-style: none;
  }
  .leaving-rows {
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    pointer-events: none;
  }
  .leaving-rows > li { position: absolute; background: #000; }
  [data-state="working"] { --indicator: ${workingColors.dark.text}; }
  [data-state="approval"], [data-state="answer"] { --indicator: ${palette.amber[400]}; }
  [data-state="completed"] { --indicator: ${palette.emerald[400]}; }
  [data-state="failed"] { --indicator: ${palette.rose[400]}; }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (prefers-reduced-motion: reduce) {
    .notch, .notch[data-animate], .notch[data-animate][data-shrinking], [data-animate] .notch-body,
    [data-animate][data-shrinking] .notch-body {
      transition: none;
    }
  }
`;
