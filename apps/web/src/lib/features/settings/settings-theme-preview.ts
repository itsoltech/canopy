import { getContext, setContext, type Snippet } from "svelte";
import type { ThemeMode } from "@canopy/ui/themes";
import type { ThemeOptions } from "./theme-customization.ts";

export interface ThemePreview {
  readonly options: ThemeOptions;
  readonly mode: ThemeMode;
}

export interface SettingsThemePreview extends ThemePreview {
  readonly opener: HTMLButtonElement;
  readonly controls: Snippet<[exit: () => void]>;
}

const previewKey = Symbol("settings-theme-preview");

interface SettingsThemePreviewHost {
  readonly available: boolean;
  start(preview: SettingsThemePreview): void;
}

export const provideSettingsThemePreview = (host: SettingsThemePreviewHost) => setContext(previewKey, host);

export const useSettingsThemePreview = () => getContext<SettingsThemePreviewHost>(previewKey);
