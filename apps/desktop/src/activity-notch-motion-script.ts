import { motion } from "@canopy/ui";

const ease = (points: readonly number[]) => `cubic-bezier(${points.join(", ")})`;

/**
 * Layer swaps for the notch page. Glyphs pop in from a blurred quarter size and settle just past full size.
 * Status pills leave upward and the new one rises from below, both through a short blur.
 */
const swaps = {
  icon: {
    exit: {
      frames: [
        { opacity: 1, scale: 1, filter: "blur(0px)" },
        { opacity: 0, scale: 0.25, filter: "blur(4px)" },
      ],
      duration: motion.quick,
      delay: 0,
    },
    enter: {
      frames: [
        { opacity: 0, scale: 0.25, filter: "blur(4px)" },
        { opacity: 1, scale: 1.12, filter: "blur(0px)", offset: 0.6 },
        { opacity: 1, scale: 1, filter: "blur(0px)" },
      ],
      duration: motion.slow,
      delay: motion.stagger,
    },
  },
  text: {
    exit: {
      frames: [
        { opacity: 1, translate: "0 0", filter: "blur(0px)" },
        { opacity: 0, translate: `0 -${motion.distance.micro}px`, filter: "blur(2px)" },
      ],
      duration: motion.quick,
      delay: 0,
    },
    enter: {
      frames: [
        { opacity: 0, translate: `0 ${motion.distance.micro}px`, filter: "blur(2px)" },
        { opacity: 1, translate: "0 0", filter: "blur(0px)" },
      ],
      duration: motion.fast,
      delay: motion.micro,
    },
  },
};

/** Expects `reducedMotion`, `numbers` and `total` from the page script. */
export const activityNotchMotionScript = `
  const swaps = ${JSON.stringify(swaps)};
  const swapEasing = { exit: "${ease(motion.inOut)}", enter: "${ease(motion.smoothOut)}" };
  let count = 0;

  function playSwap(layer, kind, phase) {
    const { frames, duration, delay } = swaps[kind][phase];
    layer.getAnimations().forEach((animation) => animation.cancel());
    layer.animate(frames, { duration, delay, easing: swapEasing[phase], fill: "backwards" });
  }

  /** Shows the layer for the state. Pass a kind to animate the change; leave it out for a first render. */
  function showState(layers, state, kind) {
    let changed = false;
    for (const layer of layers) {
      const active = layer.dataset.state === state;
      if (layer.classList.contains("active") === active) continue;
      layer.classList.toggle("active", active);
      changed = true;
      if (kind && !reducedMotion.matches) playSwap(layer, kind, active ? "enter" : "exit");
    }
    return changed;
  }

  function ping(ring, state) {
    ring.dataset.state = state;
    if (reducedMotion.matches) return;
    ring.getAnimations().forEach((animation) => animation.cancel());
    ring.animate(
      [{ opacity: 0.9, scale: 0.6 }, { opacity: 0, scale: 2.2 }],
      { duration: ${motion.verySlow}, delay: ${motion.stagger}, easing: swapEasing.enter, fill: "backwards" },
    );
  }

  function renderCount(next) {
    const formatted = next ? numbers.format(next) : "";
    if (count === next) return formatted;

    const previous = count;
    count = next;
    if (reducedMotion.matches) {
      total.textContent = formatted;
      return formatted;
    }

    const old = previous ? numbers.format(previous) : "";
    const places = Math.max(old.length, formatted.length);
    const before = old.padStart(places);
    let changed = 0;
    total.style.setProperty("--count-direction", next > previous ? "1" : "-1");
    total.replaceChildren(...Array.from(formatted.padStart(places), (digit, index) => {
      const slot = document.createElement("span");
      slot.className = "count-slot";
      if (digit === before[index]) {
        slot.textContent = digit;
        return slot;
      }

      // Digits that changed follow one another from left to right.
      slot.style.setProperty("--i", String(changed++));
      const outgoing = document.createElement("span");
      const incoming = document.createElement("span");
      outgoing.className = "count-out";
      incoming.className = "count-in";
      outgoing.textContent = before[index];
      incoming.textContent = digit;
      slot.append(outgoing, incoming);
      return slot;
    }));
    return formatted;
  }
`;
