import type { AgentToolSessionDefaults } from "@canopy/contracts";
import { InvalidError } from "./core-context.ts";

export function validateAgentToolDefaults(defaults: AgentToolSessionDefaults): void {
  if (defaults.browser) {
    const { viewportWidth: width, viewportHeight: height, colorScheme } = defaults.browser;

    if (
      (width === undefined) !== (height === undefined) ||
      [width, height].some((value) => value !== undefined && (!Number.isInteger(value) || value < 320 || value > 8192))
    )
      throw new InvalidError("Set both browser viewport dimensions between 320 and 8192 pixels.");

    if (!["", "light", "dark", "no-preference"].includes(colorScheme))
      throw new InvalidError("Choose a supported browser color scheme.");
  }

  if (defaults.desktop && (defaults.desktop.app.length > 200 || /\p{Cc}/u.test(defaults.desktop.app)))
    throw new InvalidError("Desktop app names must be at most 200 characters without control characters.");

  if (defaults.device) {
    const { platform, acquireTimeoutSeconds } = defaults.device;

    if (!["", "ios", "android", "apple"].includes(platform))
      throw new InvalidError("Choose a supported device platform.");

    if (
      acquireTimeoutSeconds !== undefined &&
      (!Number.isInteger(acquireTimeoutSeconds) || acquireTimeoutSeconds < 1 || acquireTimeoutSeconds > 240)
    )
      throw new InvalidError("Choose a device acquisition timeout between 1 and 240 seconds.");
  }
}
