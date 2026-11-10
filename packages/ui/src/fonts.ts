export type FontKind = "interface" | "mono";

export const interfaceFonts = [
  {
    value: "canopy",
    label: "Canopy (Inter)",
    stack: 'InterVariable, Inter, "Inter Fallback", ui-sans-serif, system-ui, sans-serif',
  },
  { value: "system", label: "System sans", stack: "ui-sans-serif, system-ui, sans-serif" },
  { value: "serif", label: "Charter / Georgia", stack: 'Charter, "Bitstream Charter", Georgia, serif' },
];

export const monoFonts = [
  {
    value: "system",
    label: "System monospace",
    stack: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
  },
  { value: "menlo", label: "Menlo / Liberation Mono", stack: 'Menlo, Monaco, "Liberation Mono", monospace' },
  {
    value: "consolas",
    label: "Consolas / Liberation Mono",
    stack: 'Consolas, "Cascadia Code", "Liberation Mono", monospace',
  },
];

export function fontPresets(kind: FontKind) {
  return kind === "mono" ? monoFonts : interfaceFonts;
}

/** A single family, never a CSS declaration or an unquoted font stack. */
export function validFontFamily(family: string): boolean {
  return family.length > 0 && family.length <= 200 && family === family.trim() && !/[\p{Cc}\p{Cf}]/u.test(family);
}

export function localFontFamily(value: string): string | undefined {
  const family = value.startsWith("local:") ? value.slice(6) : "";

  return validFontFamily(family) ? family : undefined;
}

export function quoteFontFamily(family: string): string {
  return `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function fontStack(value: string, kind: FontKind): string {
  const presets = fontPresets(kind);
  const fallback = kind === "mono" ? monoFonts[0]!.stack : interfaceFonts[0]!.stack;
  const preset = presets.find((font) => font.value === value);
  const family = localFontFamily(value);

  return preset?.stack ?? (family ? `${quoteFontFamily(family)}, ${fallback}` : fallback);
}

/** Collapse full names/styles to case-insensitive families without losing display spelling. */
export function fontFamilies(families: readonly string[]): string[] {
  const unique = new Map<string, string>();

  for (const raw of families) {
    const family = raw.trim();

    if (validFontFamily(family) && !unique.has(family.toLocaleLowerCase()))
      unique.set(family.toLocaleLowerCase(), family);
  }

  return [...unique.values()].sort((a, b) => a.localeCompare(b));
}
