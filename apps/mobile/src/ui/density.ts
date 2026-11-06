import { createContext, useContext } from "react";

/**
 * The settings rhythm (web: features/settings/density.css): standard controls grow to 44 dp on phones there.
 * Overlays opened from settings keep their own compact size.
 */
export const SettingsDensity = createContext(false);

export const useSettingsDensity = () => useContext(SettingsDensity);

/** Header actions of settings groups and banners use the `sm` buttons (web: `size="sm"` there). */
export const CompactControls = createContext(false);

export const useCompactControls = () => useContext(CompactControls);
