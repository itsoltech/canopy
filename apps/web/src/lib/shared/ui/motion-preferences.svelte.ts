import { prefersReducedMotion } from "svelte/motion";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";

export const motionPreferences = {
  get disabled() {
    return devicePreferences.values.animations === "off";
  },
  get reduced() {
    return this.disabled || devicePreferences.values.reduceMotion === "always" || prefersReducedMotion.current;
  },
  get speed() {
    return devicePreferences.values.animationSpeed;
  },
};
