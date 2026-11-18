import { app } from "electron";
import { registerSecondInstance } from "./relaunch.ts";

/** Closing the last window quits on Windows/Linux; macOS keeps services running until Quit. */
export function registerDesktopLifecycle(
  scheme: string,
  quitting: () => boolean,
  showMain: () => void,
  enrollment: (link: string) => void,
) {
  registerSecondInstance(scheme, quitting, (link) => (link ? enrollment(link) : showMain()));
  app.on("open-url", (event, url) => {
    event.preventDefault();
    enrollment(url);
  });
  app.on("window-all-closed", () => !quitting() && process.platform !== "darwin" && app.quit());
  app.on("activate", showMain);
  process.on("SIGTERM", () => app.quit());
  process.on("SIGINT", () => app.quit());
}
