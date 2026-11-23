import { createContext, useContext } from "react";

/**
 * The settings rhythm (web: features/settings/density.css): standard controls grow to 44 dp on phones there.
 * Overlays opened from settings keep their own compact size.
 */
export const SettingsDensity = createContext(false);

export const useSettingsDensity = () => useContext(SettingsDensity);

/** Row actions meet their control edge; a sheet footer can fill a phone's width. */
export const SettingsButtonAlignment = createContext<"flex-start" | "flex-end" | "stretch">("flex-start");

/** Header actions of settings groups and banners use the `sm` buttons (web: `size="sm"` there). */
export const CompactControls = createContext(false);

export const useCompactControls = () => useContext(CompactControls);

/** Some settings flows require a larger native touch target without changing overlay typography. */
export const MinimumTouchTarget = createContext(44);
export const useMinimumTouchTarget = () => useContext(MinimumTouchTarget);
