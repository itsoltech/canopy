import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

/** Largest icon file sent inline with a catalog entry. */
export const MAX_ICON_BYTES = 24 * 1024;

const ICON_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * A skill's or plugin's icon for the composer: a small local file as a data: URI, an https URL as it is; anything
 * else (missing, too big, another type, another scheme) = no icon (the UI shows the kind's icon).
 */
export function catalogIcon(source: string | null | undefined): string {
  if (!source) return "";

  if (source.startsWith("https://")) return source;
  const type = ICON_TYPES[extname(source).toLowerCase()];

  if (!type || !source.startsWith("/")) return "";

  try {
    if (statSync(source).size > MAX_ICON_BYTES) return "";

    return `data:${type};base64,${readFileSync(source).toString("base64")}`;
  } catch {
    return "";
  }
}
