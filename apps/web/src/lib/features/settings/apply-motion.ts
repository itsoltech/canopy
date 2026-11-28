import { motion } from "@canopy/ui";
import { motionPreferences } from "#lib/shared/ui/motion-preferences.svelte.ts";

const durations = {
  stagger: motion.stagger,
  micro: motion.micro,
  quick: motion.quick,
  fast: motion.fast,
  medium: motion.medium,
  slow: motion.slow,
  "very-slow": motion.verySlow,
  shimmer: motion.shimmer.duration,
};

export function applyMotionPreferences(): void {
  const root = document.documentElement;
  const speed = motionPreferences.speed;
  const scale = motionPreferences.disabled ? 0 : speed === "slow" ? 1.5 : speed === "fast" ? 0.7 : 1;
  root.dataset.motion = motionPreferences.disabled ? "off" : motionPreferences.reduced ? "reduced" : "full";

  // Keep times in ms so scripted transitions and CSS read the same resolved durations.
  for (const [token, ms] of Object.entries(durations)) {
    const name = `--duration-${token}`;

    if (scale === 1) root.style.removeProperty(name);
    else root.style.setProperty(name, `${Math.round(ms * scale)}ms`);
  }
}
