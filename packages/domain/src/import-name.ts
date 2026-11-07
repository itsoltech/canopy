import { createHash } from "node:crypto";

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Generated import names use the stores' UTF-16 length limits. Keep fixed labels and suffixes intact, shorten
 * only at grapheme boundaries, and distinguish values that share a prefix. Portable skill names use a hyphen.
 */
export function importName(
  value: string,
  limit: number,
  { prefix = "", suffix = "", portable = false }: { prefix?: string; suffix?: string; portable?: boolean } = {},
): string {
  if (prefix.length + value.length + suffix.length <= limit) return `${prefix}${value}${suffix}`;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  const ending = `${portable ? "-" : "…-"}${hash}${suffix}`;
  const budget = limit - prefix.length - ending.length;
  let shortened = "";

  for (const { segment } of graphemes.segment(value)) {
    if (shortened.length + segment.length > budget) break;
    shortened += segment;
  }

  return `${prefix}${portable ? shortened.replace(/-+$/, "") : shortened}${ending}`;
}
