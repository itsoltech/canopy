// Leave room below GitHub's 125,000-character limit, also when counting UTF-16 code units.
export const RELEASE_BODY_LIMIT = 124_000;
const priority = (heading) => ["features", "bug fixes", "performance improvements"].indexOf(heading.toLowerCase());

/** Preserve ordinary notes verbatim; oversized bodies retain complete bullets, features and fixes first. */
export function limitReleaseBody(body, compareUrl = "https://github.com/itsoltech/canopy/releases") {
  if (body.length <= RELEASE_BODY_LIMIT) return body;
  const originalCompare = /\]\((https:\/\/github\.com\/[^\s)]+\/compare\/[^\s)]+)\)/.exec(body)?.[1];

  const link =
    [originalCompare, compareUrl].find((url) => url && url.length <= 2_048) ??
    "https://github.com/itsoltech/canopy/releases";

  const entries = [];
  let heading = "Changes";

  for (const line of body.split(/\r?\n/)) {
    const title = /^#{1,6}\s+(.+)/.exec(line);

    if (title) heading = title[1];
    else if (/^[-*]\s+/.test(line)) entries.push({ heading, line });
  }

  const rank = (heading) => (priority(heading) < 0 ? 3 : priority(heading));
  entries.sort((a, b) => rank(a.heading) - rank(b.heading));
  const footer = (count) => `\n\n… and ${count} more changes.\n\n[Full changelog](${link})\n`;
  const parts = [];
  let length = 0;
  let previous = "";

  for (const [index, entry] of entries.entries()) {
    const part = `${previous === entry.heading ? "" : `\n\n### ${entry.heading}\n\n`}${entry.line}\n`;

    if (length + part.length + footer(entries.length - index - 1).length > RELEASE_BODY_LIMIT) break;
    parts.push(part);
    length += part.length;
    previous = entry.heading;
  }

  // Non-Angular prose still has a bounded representation and a link to the source.
  const suffix = footer(entries.length - parts.length);

  return (entries.length ? parts.join("") : body.slice(0, RELEASE_BODY_LIMIT - suffix.length)) + suffix;
}
