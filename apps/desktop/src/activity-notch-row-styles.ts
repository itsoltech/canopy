import { motion } from "@canopy/ui";
import { threadRowMarks } from "@canopy/ui/thread-row";

/**
 * A notch row reads like a sidebar thread row: the project mark and name with the status pill, the title,
 * then the worker and directory, the branch and the provider mark. Rows with fewer lines stay centered.
 */
export const activityNotchRowStyles = `
  :root {
    --row-mark-size: ${threadRowMarks.slot}px;
    --row-place-icon: 14px;
  }
  .row {
    display: grid;
    grid-template-columns: [mark] var(--row-mark-size) [label] minmax(0, 1fr) [status] auto;
    align-content: center;
    align-items: center;
    column-gap: 8px;
    row-gap: 2px;
    width: 100%;
    height: var(--row-height);
    padding: 0 10px;
    border-radius: var(--radius-md);
    text-align: start;
    font-variant-numeric: tabular-nums;
  }
  @media (hover: hover) {
    .row:hover { background-color: color-mix(in srgb, var(--ink) 8%, transparent); }
  }
  .row:active {
    background-color: color-mix(in srgb, var(--ink) 12%, transparent);
    scale: ${motion.scale.tiny};
  }
  .row-mark {
    grid-area: 1 / mark;
    display: grid;
    place-items: center;
    width: var(--row-mark-size);
    height: var(--row-mark-size);
    overflow: hidden;
    border-radius: 0.3125rem;
    font: 700 0.5625rem / 1 ui-monospace, monospace;
    letter-spacing: -0.025em;
  }
  .row-mark[data-empty] {
    width: 16px;
    height: 16px;
    justify-self: center;
    border: 1.5px dashed color-mix(in srgb, var(--ink) 40%, transparent);
    border-radius: 0.25rem;
  }
  .row-mark canvas, .row-mark img {
    display: block;
    width: 100%;
    height: 100%;
  }
  .truncate {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-project {
    grid-area: 1 / label;
    color: var(--muted);
    font-size: var(--type-meta);
    line-height: 1.125rem;
  }
  .row-status { grid-row: 1; }
  /* Text that swaps stacks the old and new layer in one cell while they cross. */
  .swap {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
  }
  .swap > .swap-layer { grid-area: 1 / 1; min-width: 0; }
  .row-title {
    grid-column: 1 / -1;
    color: color-mix(in srgb, var(--ink) 92%, transparent);
  }
  .row-place {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--muted);
    font-size: var(--type-meta);
    line-height: 1rem;
  }
  .row-place[hidden], .row-place > [hidden] { display: none; }
  .row-worker, .row-branch {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
  }
  .row-worker { flex: 0 1 auto; max-width: 45%; }
  .row-branch { flex: 1 1 0; }
  .row-worker:has(+ .row-branch[hidden]) { max-width: none; }
  .place-icon {
    flex: none;
    width: var(--row-place-icon);
    height: var(--row-place-icon);
    color: color-mix(in srgb, var(--muted) 80%, transparent);
  }
  .branch-name { display: flex; min-width: 0; }
  .branch-swap { flex: 1 1 auto; }
  .branch-start {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }
  .branch-end { flex: none; white-space: pre; }
  .row-provider {
    display: flex;
    flex: none;
    margin-left: auto;
  }
  .row-provider svg {
    width: var(--row-place-icon);
    height: var(--row-place-icon);
  }
  .row-provider:empty { display: none; }
  @media (prefers-reduced-motion: reduce) {
    .row:active { scale: 1; }
  }
`;
