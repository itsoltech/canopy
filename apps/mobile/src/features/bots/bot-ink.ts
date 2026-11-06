import { normalizeColor } from "@canopy/ui/mascot";

const channels = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));

/**
 * A bot's name and chip colour (web: botTextTone): its colour mixed towards black in light mode (72 %) and white in
 * dark mode (70 %), so it reads on the page. Without a colour, `fallback`.
 */
export function botInk(color: string | undefined, dark: boolean, fallback: string): string {
  const hex = normalizeColor(color ?? "");

  if (!hex) return fallback;
  const share = dark ? 0.7 : 0.72;
  const target = dark ? 255 : 0;

  return `#${channels(hex)
    .map((value) =>
      Math.round(value * share + target * (1 - share))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
