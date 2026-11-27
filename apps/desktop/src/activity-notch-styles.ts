import { motion, palette, radius } from "@canopy/ui";
import { interfaceFonts } from "@canopy/ui/fonts";
import { workingColors } from "@canopy/ui/thread-row";
import { themeVariables } from "@canopy/ui/themes";
import {
  activityNotchBottomInset,
  activityNotchEarWidth,
  activityNotchGripWidth,
  activityNotchRowHeight,
  activityNotchSimulatedHeight,
  activityNotchWingWidth,
} from "./activity-notch-geometry.ts";

const colors = themeVariables("ash", "dark");
const ease = (points: readonly number[]) => `cubic-bezier(${points.join(", ")})`;

/** A row added below the visible list waits until the growing outline has room for it. */
export const activityNotchPanelDelay = motion.micro * 2;

export const activityNotchStyles = `
  :root {
    --ear: ${activityNotchEarWidth}px;
    --wing: ${activityNotchWingWidth}px;
    --row-height: ${activityNotchRowHeight}px;
    --bottom-inset: ${activityNotchBottomInset}px;
    --header: ${activityNotchSimulatedHeight}px;
    --grip: ${activityNotchGripWidth}px;
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
  .rows {
    max-height: max(0px, calc(var(--list-h) - var(--bottom-inset)));
    margin: 0 var(--bottom-inset) var(--bottom-inset);
    padding: 0;
    overflow: auto;
    overscroll-behavior: contain;
    /* No reserved gutter: the rows keep the same inset on the sides as at the bottom. */
    scrollbar-color: var(--border) transparent;
    scrollbar-width: thin;
    list-style: none;
  }
  [data-header="end"] .rows { margin: var(--bottom-inset) var(--bottom-inset) 0; }
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
`;
