import { app, dialog } from "electron";
import type { Logs } from "./runtime/log.ts";

export const startupFailure = (logs: Logs) => (cause: unknown) => {
  const message = logs.redact(cause instanceof Error ? cause.message : "Canopy startup failed");
  logs.write("desktop", message);
  dialog.showErrorBox("Canopy could not start", message);
  app.quit();
};
