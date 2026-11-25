import type { BrowserWindow } from "electron";
import type { DesktopHtmlCommand } from "@canopy/ui/desktop";
import { VIEWER_FRAME_BYTES } from "./html-viewer-input.ts";
import { ViewerControls } from "./html-viewer-controls.ts";

/** Backpressure belongs to the producer: neither process queues PNGs for a slow host. */
export function streamViewer(target: BrowserWindow, fail: (message: string) => void) {
  const controls = new ViewerControls(target.webContents, fail);
  let awaitingAck = false;
  let dirty = false;
  let visible = true;
  let lastFrame = 0;
  const waitForFirstFrame = () => setTimeout(() => fail("Couldn't open this visual."), 10_000);
  let firstFrameTimeout = waitForFirstFrame();
  target.webContents.setFrameRate(15);
  target.webContents.on("paint", (_event, _rect, image) => {
    dirty = true;

    if (awaitingAck || !visible || Date.now() - lastFrame < 1000 / 15 || image.isEmpty()) return;
    const { width, height } = target.getContentBounds();
    const png = image.resize({ width, height }).toPNG();

    // Electron returns an empty buffer when it cannot encode the current surface. Try again on the next paint.
    if (!png.byteLength) return;

    if (png.byteLength > VIEWER_FRAME_BYTES) {
      fail("This visual's frame is too large to display.");

      return;
    }

    if (!lastFrame) clearTimeout(firstFrameTimeout);
    awaitingAck = true;
    dirty = false;
    lastFrame = Date.now();
    // Advanced IPC serialization preserves the byte array without a JSON number array.
    process.send?.({ type: "frame", png, width, height });
  });

  // Repaint a dropped final update even when the document has stopped animating.
  const repaint = setInterval(() => {
    if (dirty && visible && !awaitingAck && !target.isDestroyed()) target.webContents.invalidate();
  }, 70);

  target.once("closed", () => {
    clearTimeout(firstFrameTimeout);
    clearInterval(repaint);
    controls.dispose();
  });

  return (command: DesktopHtmlCommand) => {
    if (target.isDestroyed()) return;

    switch (command.type) {
      case "ack":
        awaitingAck = false;

        return;
      case "resize":
        target.setContentSize(command.width, command.height);
        dirty = true;

        return;
      case "host":
        if (command.message.type === "visibility") {
          const resumed = !visible && command.message.visible;
          visible = command.message.visible;

          if (visible) {
            if (resumed && !lastFrame) firstFrameTimeout = waitForFirstFrame();
            target.webContents.startPainting();
            dirty = true;
          } else {
            clearTimeout(firstFrameTimeout);
            target.webContents.stopPainting();
          }
        }

        return;
      case "input": {
        const input = command.event;

        if ("x" in input) {
          const { width, height } = target.getContentBounds();

          if (input.x >= width || input.y >= height) return;
        }

        controls.send(input);

        return;
      }
    }
  };
}
