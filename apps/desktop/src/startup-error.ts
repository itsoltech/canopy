import { app, dialog } from "electron";
import type { Logs } from "./runtime/log.ts";

export const startupFailure = (logs: Logs, quitting: () => boolean) => (cause: unknown) => {
  if (quitting()) return;
  const message = logs.redact(cause instanceof Error ? cause.message : "Canopy startup failed");
  logs.write("desktop", message);
  dialog.showErrorBox("Canopy could not start", cause instanceof Error && message ? message : "Open Canopy again.");
  app.quit();
};
