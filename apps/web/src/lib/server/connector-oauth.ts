import { randomBytes } from "node:crypto";

// Electron opens sign-in in the system browser, which has a separate cookie jar. The desktop
// binding stays in this BFF process; the gateway still requires its single-use, owner/account-bound
// state. Restarting the BFF invalidates pending desktop flows. Web sessions keep their private cookie.
const desktopBinding = randomBytes(32).toString("base64url");

export function connectorOAuthBinding(cookie: string | undefined): string {
  return process.env["CANOPY_WEB_ORIGIN"] ? desktopBinding : (cookie ?? "");
}
