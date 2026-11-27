import { motion } from "@canopy/ui";

/** Rows after this one share its delay, so a full list still settles soon after the outline. */
export const activityNotchStaggerLimit = 4;

/**
 * Swaps, counts and the list reveal. Each change blurs out of the old value and settles into the new one,
 * so the notch reads as one surface that changes state rather than a set of separate parts.
 */
export const activityNotchMotionStyles = `
  .state-layer {
    grid-area: 1 / 1;
    color: var(--indicator, var(--muted));
    opacity: 0;
  }
  .state-layer.active { opacity: 1; }
  .wing {
    position: relative;
    display: grid;
    place-items: center;
    color: var(--muted);
    transition:
      opacity var(--wing-enter-dur) var(--ease-smooth-out) var(--wing-enter-delay),
      filter var(--wing-enter-dur) var(--ease-smooth-out) var(--wing-enter-delay),
      scale var(--wing-enter-dur) var(--ease-spring) var(--wing-enter-delay),
      transform var(--press-dur) var(--ease-smooth-out);
  }
  .notch:not([data-active]) .wing {
    opacity: 0;
    filter: blur(var(--swap-blur));
    scale: var(--wing-start-scale);
    transition:
      opacity var(--fade-duration) var(--ease-smooth-out),
      filter var(--fade-duration) var(--ease-smooth-out),
      scale var(--fade-duration) var(--ease-smooth-out);
  }
  /* The press uses transform, so releasing it never waits for the appear delay on scale. */
  .notch-toggle:active .wing { transform: scale(${motion.scale.large}); }
  .wing svg {
    display: block;
    width: 16px;
    height: 16px;
  }
  /* A soft ring of the new state's colour leaves the glyph when it changes. */
  .ping {
    grid-area: 1 / 1;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: radial-gradient(circle, transparent 35%, color-mix(in srgb, var(--indicator, var(--muted)) 55%, transparent) 70%, transparent 72%);
    opacity: 0;
    pointer-events: none;
  }
  @keyframes spin { to { rotate: 1turn; } }
  .count {
    grid-column: 3;
    color: var(--ink);
    font-size: 0.75rem;
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
  /* The old digit leaves with blur, the new one rises into place just past full size and settles. */
  .count-in {
    animation: count-in var(--count-in-dur) var(--ease-smooth-out) both;
    animation-delay: calc(var(--count-overlap) + var(--i, 0) * var(--stagger));
  }
  .count-out {
    animation: count-out var(--count-out-dur) var(--ease-in-out) both;
    animation-delay: calc(var(--i, 0) * var(--stagger));
  }
  @keyframes count-in {
    0% {
      opacity: 0;
      translate: 0 calc(var(--count-direction) * var(--count-distance));
      scale: var(--count-start-scale);
      filter: blur(var(--count-blur));
    }
    55% {
      opacity: 1;
      translate: 0 calc(var(--count-direction) * var(--count-lift));
      scale: var(--count-peak);
      filter: blur(0);
    }
    100% { opacity: 1; translate: 0 0; scale: 1; filter: blur(0); }
  }
  @keyframes count-out {
    to {
      opacity: 0;
      translate: 0 calc(-1 * var(--count-direction) * var(--count-distance));
      scale: var(--count-start-scale);
      filter: blur(var(--count-blur));
    }
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
    transition: visibility 0s;
  }
  /* Each row comes down out of the header with blur, one after another, as the outline reaches it. */
  .row {
    opacity: 0;
    filter: blur(var(--row-enter-blur));
    translate: 0 calc(-1 * var(--row-enter-distance));
    transition:
      opacity 0s var(--panel-exit-dur),
      filter 0s var(--panel-exit-dur),
      translate 0s var(--panel-exit-dur),
      background-color var(--press-dur) var(--ease-smooth-out),
      scale var(--press-dur) var(--ease-smooth-out);
  }
  .panel[data-visible] .row {
    --row-delay: calc(var(--panel-enter-delay) + min(var(--i, 0), ${activityNotchStaggerLimit}) * var(--stagger));
    opacity: 1;
    filter: none;
    translate: 0 0;
    transition:
      opacity var(--row-enter-dur) var(--ease-smooth-out) var(--row-delay),
      filter var(--row-enter-dur) var(--ease-smooth-out) var(--row-delay),
      translate var(--row-enter-dur) var(--ease-smooth-out) var(--row-delay),
      background-color var(--press-dur) var(--ease-smooth-out),
      scale var(--press-dur) var(--ease-smooth-out);
  }
  .row-status {
    grid-column: status;
    display: grid;
    justify-items: end;
  }
  .status {
    position: relative;
    isolation: isolate;
    padding: 0 0.4375rem;
    font-size: var(--type-meta);
    line-height: 1.125rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .status::before {
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: 999px;
    background: color-mix(in srgb, var(--indicator) 16%, transparent);
    content: "";
  }
  /* Work in progress keeps a slow sweep of light, like the live labels in the app. */
  .status.active[data-state="working"] {
    background: linear-gradient(90deg,
      var(--indicator) ${motion.shimmer.start * 100}%,
      color-mix(in srgb, var(--indicator) 35%, var(--ink)) ${motion.shimmer.peak * 100}%,
      var(--indicator) ${motion.shimmer.end * 100}%) 0 0 / ${motion.shimmer.backgroundSize * 100}% 100%;
    background-clip: text;
    color: transparent;
    animation: shimmer ${motion.shimmer.duration}ms linear infinite;
  }
  @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
  @media (prefers-reduced-motion: reduce) {
    .wing, .notch:not([data-active]) .wing, .panel, .panel[data-visible], .row,
    .panel[data-visible] .row {
      transition: none;
    }
    .panel, .row, .notch:not([data-active]) .wing { filter: none; scale: 1; translate: 0 0; }
    .notch-toggle:active .wing { transform: none; }
    .count-in, .count-out, .status.active[data-state="working"] { animation: none; }
    .count-out { display: none; }
  }
`;
