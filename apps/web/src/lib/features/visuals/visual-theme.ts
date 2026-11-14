import { isThemeName } from "@canopy/ui/themes";
import { visualTheme, type VisualTheme } from "@canopy/domain/visuals";

/** The visual's tokens for the current Canopy appearance: theme, light/dark and Interface size. */
export function currentVisualTheme(): VisualTheme {
  const root = document.documentElement;
  const mode = root.classList.contains("dark") ? "dark" : "light";
  const name = root.dataset[mode === "dark" ? "darkTheme" : "lightTheme"];
  const scale = Math.min(1.5, Math.max(0.75, parseFloat(getComputedStyle(root).fontSize) / 16 || 1));

  return visualTheme(isThemeName(name) ? name : "birch", mode, scale);
}

export const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

/** One observer for every mounted visual: appearance changes reach them without a reload. */
export function onVisualThemeChange(listener: () => void): () => void {
  if (!observer) {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-light-theme", "data-dark-theme", "style"],
    });
  }

  listeners.add(listener);

  return () => {
    listeners.delete(listener);

    if (listeners.size) return;
    observer?.disconnect();
    observer = undefined;
  };
}
