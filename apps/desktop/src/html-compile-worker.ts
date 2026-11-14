import { parentPort, workerData } from "node:worker_threads";
import { randomBytes } from "node:crypto";
import { mountVisualShell } from "@canopy/domain/visual-shell";
import type { VisualTheme } from "@canopy/domain/visuals";

/** Only the main process supplies this worker's bounded, validated source and theme. */
const input: { specJson: string; title: string; theme: VisualTheme } = workerData;

parentPort?.postMessage(
  mountVisualShell(input.specJson, {
    title: input.title,
    kitVersion: 2,
    htmlDocument: true,
    showWarning: true,
    reducedMotion: false,
    state: undefined,
    theme: input.theme,
    random: () => randomBytes(18).toString("base64url"),
  }),
);
