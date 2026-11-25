/** Exact conversation routes accepted by the activity notch. */
export function isDesktopActivityRoute(value: string): boolean {
  return /^\/(?:threads|bots)\/[a-zA-Z0-9~-]{1,100}$/.exec(value)?.[0] === value;
}

/** Only Settings and conversation paths can cross the desktop navigation bridge. */
export function isDesktopRoute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (isDesktopActivityRoute(value) || /^\/settings(?:\/[a-zA-Z0-9_-]+)*\/?$/.exec(value)?.[0] === value)
  );
}
