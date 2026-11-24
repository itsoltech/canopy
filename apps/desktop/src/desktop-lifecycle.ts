import { app } from "electron";
import { resolve } from "node:path";
import type { desktopIdentity } from "./identity.ts";
import { registerSecondInstance } from "./relaunch.ts";

/** Configure the shell before taking the instance lock, which depends on userData. */
export function configureDesktopApplication(identity: ReturnType<typeof desktopIdentity>) {
  const userData = process.env["CANOPY_USER_DATA"];

  if (userData) app.setPath("userData", resolve(userData));
  app.setAboutPanelOptions({ applicationName: identity.displayName });

  if (process.platform === "win32") app.setAppUserModelId(identity.appId);

  // Chromium does not recognize every Linux desktop (e.g. Hyprland). Select a real
  // keychain backend explicitly instead of silently falling back to basic_text.
  if (process.platform === "linux" && !app.commandLine.hasSwitch("password-store"))
    app.commandLine.appendSwitch(
      "password-store",
      /kde/i.test(process.env["XDG_CURRENT_DESKTOP"] ?? "") ? "kwallet6" : "gnome-libsecret",
    );

  // Bound Chromium's disposable HTTP cache separately from desktop history and updates.
  app.commandLine.appendSwitch("disk-cache-size", String(64 * 1024 * 1024));
  const ownsInstance = app.requestSingleInstanceLock();

  if (!ownsInstance) app.quit();

  return ownsInstance;
}

/** Closing the last window quits on Windows/Linux; macOS keeps services running until Quit. */
export function registerDesktopLifecycle(
  scheme: string,
  quitting: () => boolean,
  showMain: () => void,
  enrollment: (link: string) => void,
  requestQuit: (source: "last-window" | "SIGTERM" | "SIGINT") => void,
) {
  registerSecondInstance(scheme, quitting, (link) => (link ? enrollment(link) : showMain()));
  app.on("open-url", (event, url) => {
    event.preventDefault();
    enrollment(url);
  });
  app.on("window-all-closed", () => !quitting() && process.platform !== "darwin" && requestQuit("last-window"));
  app.on("activate", showMain);
  process.on("SIGTERM", () => requestQuit("SIGTERM"));
  process.on("SIGINT", () => requestQuit("SIGINT"));
}
