import { motion, palette, radius } from "@canopy/ui";
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

export const activityNotchStyles = `
  :root {
    --notch-height: ${activityNotchSimulatedHeight}px;
    --ear: ${activityNotchEarWidth}px;
    --wing: ${activityNotchWingWidth}px;
    --row-height: ${activityNotchRowHeight}px;
    --project-mark-size: 18px;
    --bottom-inset: ${activityNotchBottomInset}px;
    --type-compact: 0.8125rem;
    --type-meta: 0.71875rem;
    --radius-md: ${radius.md}px;
    --notch-radius: ${radius.xl}px;
    --hover: ${colors.hover};
    --ink: ${colors.ink};
    --muted: ${colors.muted};
    --border: ${colors.border};
    --acc-expand: ${motion.fast}ms;
    --acc-collapse: ${motion.quick}ms;
    --acc-ease: cubic-bezier(${motion.smoothOut.join(", ")});
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    overflow: hidden;
    color: var(--ink);
    font: var(--type-compact) / 1.25rem system-ui, sans-serif;
    user-select: none;
  }
  button {
    appearance: none;
    border: 0;
    color: inherit;
    background: none;
    font: inherit;
  }
  button:not(:disabled) { cursor: pointer; }
  button:focus-visible {
    outline: 2px solid ${palette.sky[400]};
    outline-offset: -3px;
  }
  .notch {
    position: relative;
    margin-inline: var(--ear);
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
    overflow: hidden;
    border-radius: 0 0 var(--notch-radius) var(--notch-radius);
    background: #000;
    color-scheme: dark;
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
    color: var(--indicator, var(--muted));
  }
  .wing svg, .spinner {
    display: block;
    width: 16px;
    height: 16px;
  }
  .spinner {
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin ${motion.spin}ms linear infinite;
  }
  @keyframes spin { to { rotate: 1turn; } }
  .count {
    grid-column: 3;
    font-size: var(--type-meta);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .panel {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--panel-duration, var(--acc-collapse)) var(--acc-ease);
  }
  .notch[data-open="true"] .panel {
    --panel-duration: var(--acc-expand);
    grid-template-rows: 1fr;
  }
  .panel-inner {
    min-height: 0;
    overflow: hidden;
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
  }
  .row:hover { background: var(--hover); }
  .rows:has(.project-mark:not([hidden])) .row {
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
  .status {
    grid-column: status;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: var(--type-meta);
    line-height: 1rem;
    font-weight: 500;
  }
  .status::before {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--indicator);
    content: "";
  }
  [data-state="working"] { --indicator: ${palette.sky[400]}; }
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
    .panel { transition: none; }
    .spinner { animation: none; }
  }
`;
