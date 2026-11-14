import { app } from "electron";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { ShellMountResult } from "@canopy/domain/visual-shell";
import type { VisualTheme } from "@canopy/domain/visuals";

/** Bounded parsing/hashing runs outside Electron's main event loop. */
export function compileViewer(specJson: string, title: string, theme: VisualTheme): Promise<ShellMountResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(app.getAppPath(), "dist/html-compile-worker.cjs"), {
      workerData: { specJson, title, theme },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });

    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("HTML compilation timed out"));
    }, 10000);

    worker.once("message", (result: ShellMountResult) => {
      clearTimeout(timeout);
      resolve(result);
    });
    worker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timeout);

      if (code !== 0) reject(new Error("HTML compilation failed"));
    });
  });
}
