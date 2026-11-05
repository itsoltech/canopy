import type { DevicePreferences } from "./device-preferences.svelte.ts";

const fonts = {
  canopy: 'InterVariable, Inter, "Inter Fallback", ui-sans-serif, system-ui, sans-serif',
  system: "ui-sans-serif, system-ui, sans-serif",
  serif: 'Charter, "Bitstream Charter", Georgia, serif',
};

const mono = {
  system: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
  menlo: 'Menlo, Monaco, "Liberation Mono", monospace',
  consolas: 'Consolas, "Cascadia Code", "Liberation Mono", monospace',
};

export function applyDeviceAppearance(device: DevicePreferences): void {
  const values = device.values;
  const root = document.documentElement;
  root.style.setProperty(
    "--font-sans",
    Object.entries(fonts).find(([key]) => key === values.interfaceFont)?.[1] ?? fonts.canopy,
  );
  root.style.setProperty(
    "--font-mono",
    Object.entries(mono).find(([key]) => key === values.monoFont)?.[1] ?? mono.system,
  );
  root.style.setProperty("font-size", `${(16 * Number(values.interfaceSize)) / 14}px`);
  root.style.setProperty("--canopy-mono-size", `${values.monoSize}px`);
  root.dataset.contrast = values.contrast;
  root.dataset.wrapCode = values.wrapCode;
  root.dataset.wrapDiffs = values.wrapDiffs;
  root.dataset.diffColors = values.diffColors;
}
