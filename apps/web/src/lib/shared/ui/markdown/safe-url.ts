/** Only absolute web and mail links become clickable; everything else (javascript:, data:, relative paths) stays text. */
export function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
