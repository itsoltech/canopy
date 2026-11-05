/** Only Settings paths can cross the desktop navigation bridge. No origins, queries or traversal. */
export function isDesktopRoute(value: unknown): value is string {
  return typeof value === "string" && /^\/settings(?:\/[a-zA-Z0-9_-]+)*\/?$/.exec(value)?.[0] === value;
}
