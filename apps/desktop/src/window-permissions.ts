/** Both setup and the web UI use copy actions and the Notification API fallback. */
const SHARED_PERMISSIONS = new Set(["clipboard-sanitized-write", "notifications"]);

export function isApplicationPage(url: string, origin: string | undefined): boolean {
  const page = URL.parse(url);

  return !!page && page.origin === origin && page.pathname !== "/desktop" && !page.pathname.startsWith("/desktop/");
}

/** Fonts belong to the application UI, never the setup page or an embedded origin. */
export function allowedFontAccess(url: string, appOrigin: string | undefined, mainFrame = true): boolean {
  if (!appOrigin || !mainFrame) return false;

  try {
    const requested = new URL(url);

    return requested.origin !== "null" && requested.origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

interface PermissionContext {
  setupOrigin: string;
  webOrigin: string | undefined;
  /** Present only for requests from the top-level document. */
  mainFrameUrl: string | undefined;
}

export function allowedPermission(
  permission: string,
  url: string,
  { setupOrigin, webOrigin, mainFrameUrl }: PermissionContext,
) {
  if (permission === "fullscreen")
    return !!mainFrameUrl && isApplicationPage(mainFrameUrl, webOrigin) && isApplicationPage(url, webOrigin);

  if (permission === "local-fonts")
    return !!mainFrameUrl && allowedFontAccess(mainFrameUrl, webOrigin) && allowedFontAccess(url, webOrigin);

  const origin = URL.parse(url)?.origin;

  return !!origin && (origin === setupOrigin || origin === webOrigin) && SHARED_PERMISSIONS.has(permission);
}
