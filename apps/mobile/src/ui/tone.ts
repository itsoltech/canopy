import { palette } from "@canopy/ui";
import type { Tone } from "@canopy/domain/status-look";
import { useColors, type Colors } from "./theme";

/** One semantic tone (web: shared/ui/tone.ts) in this palette: text, dot, badge and tinted panel colours. */
export interface ToneColors {
  readonly text: string;
  readonly dot: string;
  readonly badge: { readonly background: string; readonly text: string; readonly ring: string };
  readonly panel: { readonly background: string; readonly text: string; readonly ring: string };
}

export function toneColors(tone: Tone, c: Colors): ToneColors {
  if (tone === "neutral")
    return {
      text: c.muted,
      dot: c.faint,
      badge: { background: c.well, text: c.soft, ring: c.dark ? "#ffffff1a" : "#09090b1a" },
      panel: { background: c.well, text: c.soft, ring: c.rule },
    };
  const scale = palette[tone];

  return {
    text: c.dark ? scale[400] : scale[700],
    dot: c.dark ? scale[400] : scale[500],
    badge: c.dark
      ? { background: `${scale[400]}1a`, text: scale[300], ring: `${scale[400]}33` }
      : { background: scale[50], text: scale[800], ring: `${scale[600]}33` },
    panel: c.dark
      ? { background: `${scale[400]}1a`, text: scale[50], ring: `${scale[400]}33` }
      : { background: scale[50], text: scale[950], ring: `${scale[600]}1a` },
  };
}

export function useTone(tone: Tone): ToneColors {
  return toneColors(tone, useColors());
}
