/** Accept CSS hex shorthand, but never arbitrary CSS or transparent colours. */
export function normalizeColor(value: string): string | undefined {
  const hex = value.trim().replace(/^#/, "");

  if (/^[\da-f]{3}$/i.test(hex))
    return `#${[...hex]
      .map((c) => c + c)
      .join("")
      .toLowerCase()}`;

  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : undefined;
}

/** WCAG sRGB relative luminance for a normalized six-digit hex color. */
export function hexLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;

    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });

  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
