import { app } from "electron";
import { Schema } from "effect";
import { createHtmlViewer } from "./html-viewer.ts";
import { ViewerInput } from "./html-viewer-input.ts";
import type { VisualTheme } from "@canopy/domain/visuals";

const directory = process.argv
  .find((arg) => arg.startsWith("--canopy-html-profile="))
  ?.split("=")
  .slice(1)
  .join("=");

if (!directory || !process.send) app.exit(1);
else {
  app.setPath("userData", directory);
  app.setPath("sessionData", directory);
  // Browser-process rules also cover speculative DNS; no app services run in this process.
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
  process.on("disconnect", () => app.exit(0));
  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(() => {
    const open = createHtmlViewer();
    process.once("message", async (message: { specJson: string; title: string; theme: VisualTheme }) => {
      try {
        const input = Schema.decodeUnknownSync(ViewerInput)(message);
        await open(input.specJson, input.title, message.theme);
        process.send?.("opened");
      } catch {
        process.send?.("error");
        app.exit(1);
      }
    });
    process.send?.("ready");
  });
}
