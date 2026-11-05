/** Permission the renderer needs for `navigator.clipboard.writeText` (copy actions). */
const CLIPBOARD_WRITE = "clipboard-sanitized-write";

/**
 * Window permissions: only clipboard writes, and only from the app's own pages (setup and web UI).
 * Clipboard reads, media, notifications and the rest stay denied.
 */
export function allowedPermission(permission: string, url: string, trusted: readonly (string | undefined)[]) {
  if (permission !== CLIPBOARD_WRITE) return false;

  try {
    return trusted.includes(new URL(url).origin);
  } catch {
    return false;
  }
}
