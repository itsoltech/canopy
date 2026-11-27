import { hexLuminance } from "@canopy/ui/color";
import type { themeVariables } from "@canopy/ui/themes";

const contrast = (fg: string, bg: string) => {
  const a = hexLuminance(fg);
  const b = hexLuminance(bg);

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

/** Text and accent below WCAG AA on any background, or a button label below AA on its button. */
export function hasLowContrast(colors: ReturnType<typeof themeVariables>): boolean {
  const lowSurface = [colors.canvas, colors.surface, colors.panel, colors.hover].some(
    (bg) => contrast(colors.ink, bg) < 4.5 || contrast(colors.muted, bg) < 4.5 || contrast(colors.accent, bg) < 3,
  );

  return lowSurface || [colors.action, colors["action-hover"]].some((bg) => contrast(colors["on-accent"], bg) < 4.5);
}
