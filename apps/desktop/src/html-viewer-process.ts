import { app } from "electron";
import { Schema, Result } from "effect";
import { HtmlViewer } from "./html-viewer.ts";
import { ViewerRequest } from "./html-viewer-input.ts";

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
    const viewer = new HtmlViewer();
    let started = false;
    process.on("message", async (message) => {
      const decoded = Schema.decodeUnknownResult(ViewerRequest)(message);

      if (Result.isFailure(decoded)) return;
      const input = decoded.success;

      if (input.type === "command") {
        viewer.command(input.command);

        return;
      }

      if (started) return;
      started = true;

      try {
        await viewer.open(input.specJson, input.title, input.theme, input.type === "start" ? input : undefined);
        process.send?.({ type: "opened" });
      } catch {
        process.send?.({ type: "error", message: "Couldn't open this visual." });
        app.exit(1);
      }
    });
    process.send?.({ type: "ready" });
  });
}
