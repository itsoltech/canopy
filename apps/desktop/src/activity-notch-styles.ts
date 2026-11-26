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

/** The list fades in once even the seventh row fits inside the growing outline. */
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
    --project-mark-size: 18px;
    --bottom-inset: ${activityNotchBottomInset}px;
    --type-compact: 0.8125rem;
    --type-meta: 0.71875rem;
    --radius-md: ${radius.md}px;
    --notch-radius: ${radius.xl}px;
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
    --panel-enter-dur: ${motion.fast}ms;
    --panel-enter-delay: ${activityNotchPanelDelay}ms;
    --panel-exit-dur: ${motion.micro}ms;
    --panel-scale: ${motion.scale.medium};
    --panel-blur: 2px;
    --icon-swap-dur: ${motion.fast}ms;
    --icon-swap-blur: 2px;
    --icon-swap-start-scale: 0.25;
    --text-swap-dur: ${motion.quick}ms;
    --text-swap-blur: 2px;
    --fade-duration: ${motion.quick}ms;
    --press-dur: ${motion.quick}ms;
    --spin-duration: ${motion.spin}ms;
    --count-distance: ${motion.distance.micro}px;
    --ease-smooth-out: ${ease(motion.smoothOut)};
    --ease-in-out: ${ease(motion.inOut)};
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
  [data-animate] .notch-body { transition: height var(--morph-open-dur) var(--morph-ease); }
  [data-animate][data-shrinking] .notch-body {
    transition: height var(--morph-close-dur) var(--morph-close-ease) var(--morph-close-delay);
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
  .wing {
    display: grid;
    place-items: center;
    color: var(--muted);
    transition: scale var(--press-dur) var(--ease-smooth-out);
  }
  .notch-toggle:active .wing { scale: ${motion.scale.large}; }
  .state-layer {
    grid-area: 1 / 1;
    color: var(--indicator, var(--muted));
    opacity: 0;
    filter: blur(var(--text-swap-blur));
    visibility: hidden;
    transition:
      opacity var(--text-swap-dur) var(--ease-in-out),
      filter var(--text-swap-dur) var(--ease-in-out),
      visibility var(--text-swap-dur);
  }
  .state-layer.active {
    opacity: 1;
    filter: none;
    visibility: visible;
  }
  .wing .state-layer {
    filter: blur(var(--icon-swap-blur));
    scale: var(--icon-swap-start-scale);
    transition:
      opacity var(--icon-swap-dur) var(--ease-in-out),
      filter var(--icon-swap-dur) var(--ease-in-out),
      scale var(--icon-swap-dur) var(--ease-in-out),
      visibility var(--icon-swap-dur);
  }
  .wing .state-layer.active {
    filter: none;
    scale: 1;
  }
  .wing svg {
    display: block;
    width: 16px;
    height: 16px;
  }
  .spinner {
    animation: spin var(--spin-duration) linear infinite;
    animation-play-state: paused;
  }
  .active > .spinner { animation-play-state: running; }
  @keyframes spin { to { rotate: 1turn; } }
  .count {
    grid-column: 3;
    font-size: var(--type-meta);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  #activity-count {
    display: inline-flex;
    justify-content: end;
    width: 2ch;
  }
  .count-slot {
    display: inline-grid;
    width: 1ch;
    place-items: center;
  }
  .count-slot > span { grid-area: 1 / 1; }
  .count-in { animation: count-in var(--fade-duration) var(--ease-smooth-out) both; }
  .count-out { animation: count-out var(--fade-duration) var(--ease-smooth-out) both; }
  @keyframes count-in {
    from { opacity: 0; translate: 0 calc(var(--count-direction) * var(--count-distance)); }
  }
  @keyframes count-out {
    to { opacity: 0; translate: 0 calc(-1 * var(--count-direction) * var(--count-distance)); }
  }
  /* The list keeps its open width and place, so the moving outline clips it instead of reflowing its titles. */
  .panel {
    position: relative;
    width: calc(var(--open-width) - 2 * var(--ear));
    margin-left: calc(var(--open-offset) - var(--notch-offset));
    opacity: 0;
    filter: blur(var(--panel-blur));
    scale: var(--panel-scale);
    transform-origin: calc(var(--notch-center, 50vw) - var(--open-offset) - var(--ear)) 0;
    visibility: hidden;
    transition:
      opacity var(--panel-exit-dur) var(--ease-smooth-out),
      filter var(--panel-exit-dur) var(--ease-smooth-out),
      scale var(--panel-exit-dur) var(--ease-smooth-out),
      visibility 0s var(--panel-exit-dur);
  }
  .panel[data-visible] {
    opacity: 1;
    filter: none;
    scale: 1;
    visibility: visible;
    transition:
      opacity var(--panel-enter-dur) var(--ease-smooth-out) var(--panel-enter-delay),
      filter var(--panel-enter-dur) var(--ease-smooth-out) var(--panel-enter-delay),
      scale var(--panel-enter-dur) var(--ease-smooth-out) var(--panel-enter-delay),
      visibility 0s;
  }
  .rows {
    max-height: max(0px, min(${activityNotchVisibleRows * activityNotchRowHeight}px, calc(100dvh - var(--notch-height) - var(--bottom-inset))));
    margin: 0 var(--bottom-inset) var(--bottom-inset);
    padding: 0;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-color: var(--border) transparent;
    scrollbar-gutter: stable both-edges;
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
  .row {
    display: grid;
    grid-template-columns: [label] minmax(0, 1fr) [status] auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: var(--row-height);
    padding: 0 8px;
    border-radius: var(--radius-md);
    text-align: start;
    font-variant-numeric: tabular-nums;
    transition:
      background-color var(--press-dur) var(--ease-smooth-out),
      scale var(--press-dur) var(--ease-smooth-out);
  }
  @media (hover: hover) {
    .row:hover { background-color: color-mix(in srgb, var(--ink) 8%, transparent); }
  }
  .row:active {
    background-color: color-mix(in srgb, var(--ink) 12%, transparent);
    scale: ${motion.scale.tiny};
  }
  .panel:has(.project-mark:not([hidden])) .row {
    grid-template-columns: [mark] var(--project-mark-size) [label] minmax(0, 1fr) [status] auto;
  }
  .project-mark:not([hidden]) {
    grid-column: mark;
    display: grid;
    place-items: center;
    width: var(--project-mark-size);
    height: var(--project-mark-size);
    overflow: hidden;
    border-radius: 0.25rem;
    font: 700 0.5625rem / 1 ui-monospace, monospace;
    letter-spacing: -0.025em;
  }
  .project-mark canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .truncate {
    grid-column: label;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-status {
    grid-column: status;
    display: grid;
    justify-items: end;
  }
  .status {
    font-size: var(--type-meta);
    line-height: 1rem;
    font-weight: 500;
    white-space: nowrap;
  }
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
    [data-animate][data-shrinking] .notch-body, .panel, .panel[data-visible], .state-layer, .wing .state-layer, .wing, .row {
      transition: none;
    }
    .panel, .state-layer, .wing .state-layer { filter: none; scale: 1; }
    .notch-toggle:active .wing, .row:active { scale: 1; }
    .spinner, .count-in, .count-out { animation: none; }
    .count-out { display: none; }
  }
`;
