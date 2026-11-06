/**
 * Permissions the app's own pages may use: `clipboard-sanitized-write` for `navigator.clipboard.writeText`
 * (copy actions) and `notifications`, a fallback for the page's Notification API (alerts use native IPC).
 */
const ALLOWED = new Set(["clipboard-sanitized-write", "notifications"]);

/**
 * Window permissions: only the allowed ones, and only from the app's own pages (setup and web UI).
 * Clipboard reads, media and the rest stay denied.
 */
export function allowedPermission(permission: string, url: string, trusted: readonly (string | undefined)[]) {
  if (!ALLOWED.has(permission)) return false;

  try {
    return trusted.includes(new URL(url).origin);
  } catch {
    return false;
  }
}
