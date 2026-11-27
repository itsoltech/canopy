import { motion, palette } from "@canopy/ui";
import { threadSpinner } from "@canopy/ui/thread-row";

const ease = (points: readonly number[]) => `cubic-bezier(${points.join(", ")})`;
const { center, radius: ring, strokeWidth, trackOpacity, path } = threadSpinner;

/**
 * The working ring and the completed check are one badge (transitions.dev "spinner to check morph", sized for the
 * 16 px wing): when work finishes, the arc stops and fades, an emerald disc fades in over the track, the check draws
 * itself while the disc is still arriving, and the badge hops and pops through a short cross-blur.
 * Going back to work reverses every layer on one shorter clock.
 */
export const activityNotchProgressGlyph = `<span class="progress-blur"><svg class="progress" viewBox="${threadSpinner.viewBox}" data-phase="spinning" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle class="progress-ring" cx="${center}" cy="${center}" r="${ring}" stroke="currentColor" stroke-width="${strokeWidth}" opacity="${trackOpacity}"/><path class="progress-arc" d="${path}" stroke="currentColor" stroke-width="${strokeWidth}"/><circle class="progress-fill" cx="${center}" cy="${center}" r="7.5"/><path class="progress-check" d="M5.1 8.3l2 2l3.8-4.2" pathLength="1" stroke-width="1.75"/></svg></span>`;

export const activityNotchProgressStyles = `
  :root {
    --progress-pop-dur: ${motion.medium}ms;
    --progress-pop-ease: cubic-bezier(0.34, 1.96, 0.94, 1);
    --progress-pop-scale: 1.09;
    --progress-fill-dur: ${motion.medium}ms;
    --progress-fill-ease: cubic-bezier(0.34, 1.35, 0.64, 1);
    --progress-draw-dur: ${motion.verySlow}ms;
    --progress-draw-delay: ${motion.micro}ms;
    --progress-draw-ease: ${ease(motion.smoothOut)};
    --progress-revert-dur: ${motion.fast}ms;
    --progress-revert-ease: ${ease(motion.smoothOut)};
    --progress-hop: 2px;
    --progress-up-dur: ${motion.fast}ms;
    --progress-up-ease: cubic-bezier(0.34, 1.35, 0.64, 1);
    --progress-down-dur: ${motion.fast}ms;
    --progress-down-ease: cubic-bezier(0.14, 2.56, 0.94, 1);
    --progress-blur: 0.5px;
    --progress-done: ${palette.emerald[400]};
  }
  /* Blurs the badge as one surface, so every layer softens together and resolves crisp. */
  .progress-blur {
    display: grid;
    filter: blur(0);
    transition: filter var(--progress-revert-dur) var(--progress-revert-ease);
  }
  .progress-blur.crossing {
    filter: blur(var(--progress-blur));
    transition: filter calc(var(--progress-fill-dur) * 0.45) var(--progress-fill-ease);
  }
  .wing .progress {
    overflow: visible;
    scale: 1;
    transition: scale var(--progress-revert-dur) var(--progress-revert-ease);
  }
  .progress[data-phase="done"] {
    scale: var(--progress-pop-scale);
    transition: scale var(--progress-pop-dur) var(--progress-pop-ease);
  }
  /* The hop plays only for the morph itself, never for a badge that is already done. */
  .progress[data-phase="done"][data-hop] {
    animation-name: progress-up, progress-down;
    animation-duration: var(--progress-up-dur), var(--progress-down-dur);
    animation-timing-function: var(--progress-up-ease), var(--progress-down-ease);
    animation-delay: 0ms, var(--progress-up-dur);
    animation-fill-mode: forwards, forwards;
  }
  @keyframes progress-up {
    from { transform: translateY(0); }
    to { transform: translateY(calc(-1 * var(--progress-hop))); }
  }
  @keyframes progress-down {
    from { transform: translateY(calc(-1 * var(--progress-hop))); }
    to { transform: translateY(0); }
  }
  .progress-ring { transition: opacity var(--progress-revert-dur) ease; }
  .progress[data-phase="done"] .progress-ring {
    opacity: 0;
    transition: opacity calc(var(--progress-fill-dur) * 0.7) ease;
  }
  .progress-arc {
    transform-box: view-box;
    transform-origin: 50% 50%;
    animation: spin var(--spin-duration) linear infinite paused;
    transition: opacity var(--progress-revert-dur) var(--progress-revert-ease);
  }
  .active .progress-arc { animation-play-state: running; }
  .progress[data-phase="done"] .progress-arc {
    opacity: 0;
    animation-play-state: paused;
    transition: opacity calc(var(--progress-fill-dur) * 0.5) ease;
  }
  .progress-fill {
    fill: var(--progress-done);
    opacity: 0;
    transition: opacity var(--progress-revert-dur) var(--progress-revert-ease);
  }
  .progress[data-phase="done"] .progress-fill {
    opacity: 1;
    transition: opacity var(--progress-fill-dur) var(--progress-fill-ease);
  }
  .progress-check {
    stroke: #000;
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    transition: stroke-dashoffset var(--progress-revert-dur) var(--progress-revert-ease);
  }
  /* The draw takes over while the disc is still arriving, so it reads as one gesture. */
  .progress[data-phase="done"] .progress-check {
    stroke-dashoffset: 0;
    transition: stroke-dashoffset var(--progress-draw-dur) var(--progress-draw-ease)
      calc(var(--progress-fill-dur) + var(--progress-draw-delay) - 200ms);
  }
  /* A first render or a change from another state shows the phase at once. */
  .progress[data-instant], .progress[data-instant] * { transition: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .progress-blur, .progress-blur.crossing { filter: none; transition: none; }
    .progress, .progress *, .progress[data-phase="done"], .progress[data-phase="done"] * {
      transition: none;
      animation: none;
    }
  }
`;

/** Expects `reducedMotion` from the page script. */
export const activityNotchProgressScript = `
  let crossingTimer;

  /** Puts the shared working/completed badge in its phase; morphs only between the two while it is shown. */
  function setProgress(layer, state, animate) {
    const badge = layer.querySelector(".progress");
    const phase = state === "completed" ? "done" : "spinning";
    if (layer.dataset.state === state) return false;
    layer.dataset.state = state;
    badge.toggleAttribute("data-hop", Boolean(animate) && phase === "done" && !reducedMotion.matches);
    if (!animate || reducedMotion.matches) {
      badge.toggleAttribute("data-instant", true);
      badge.dataset.phase = phase;
      void badge.getBoundingClientRect();
      badge.removeAttribute("data-instant");
      return false;
    }

    badge.dataset.phase = phase;
    const blur = badge.parentElement;
    clearTimeout(crossingTimer);
    blur.classList.add("crossing");
    crossingTimer = setTimeout(() => blur.classList.remove("crossing"), ${motion.medium} * 0.45);
    return true;
  }
`;
