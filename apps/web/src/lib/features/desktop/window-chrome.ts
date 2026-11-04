import type { DesktopWindowState } from "@canopy/ui/desktop";

export function applyWindowState(state: DesktopWindowState) {
  if (
    !Number.isFinite(state.zoomFactor) ||
    state.zoomFactor <= 0 ||
    (state.fullscreen !== true && state.fullscreen !== false)
  )
    return;
  document.documentElement.style.setProperty("--window-zoom", String(state.zoomFactor));
  document.documentElement.toggleAttribute("data-window-fullscreen", state.fullscreen);
}
