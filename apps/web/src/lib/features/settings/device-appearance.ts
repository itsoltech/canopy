import type { DevicePreferences } from "./device-preferences.svelte.ts";
import { fontStack } from "@canopy/ui/fonts";

export function applyDeviceAppearance(device: DevicePreferences): void {
  const values = device.values;
  const root = document.documentElement;
  root.style.setProperty("--font-sans", fontStack(values.interfaceFont, "interface"));
  root.style.setProperty("--font-mono", fontStack(values.monoFont, "mono"));
  root.style.setProperty("font-size", `${(16 * Number(values.interfaceSize)) / 14}px`);
  root.style.setProperty("--canopy-mono-size", `${values.monoSize}px`);
  root.dataset.contrast = values.contrast;
  root.dataset.wrapCode = values.wrapCode;
  root.dataset.wrapDiffs = values.wrapDiffs;
  root.dataset.diffColors = values.diffColors;
}
