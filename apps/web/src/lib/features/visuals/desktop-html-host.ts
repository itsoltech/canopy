import type { DesktopHtmlCommand, DesktopHtmlEvent } from "@canopy/ui/desktop";
import { clampVisualHeight, VISUAL_LIMITS, type HostMessage } from "@canopy/domain/visuals";
import { reportEmbedHover } from "#lib/shared/ui/virtual/embed-hover.ts";
import { bindDesktopHtmlInput } from "./desktop-html-input.ts";
import { VisualUnavailable, type FrameHandle, type FrameOptions } from "./frame-host.ts";
import { currentVisualTheme, onVisualThemeChange, prefersReducedMotion } from "./visual-theme.ts";

function previewCanvas(title: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className =
    "block h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500";
  canvas.setAttribute("aria-label", title);
  canvas.setAttribute(
    "aria-description",
    "Click to interact. Press Escape to release the keyboard. Open in window for screen reader access.",
  );
  canvas.setAttribute("role", "button");
  canvas.tabIndex = 0;

  return canvas;
}

/** Only pixels and bounded input cross this bridge; agent HTML stays in the isolated desktop process. */
export async function mountDesktopHtmlFrame(container: HTMLElement, options: FrameOptions): Promise<FrameHandle> {
  options.signal?.throwIfAborted();
  const desktop = window.canopyDesktop;

  if (!desktop?.startAgentHtml || !desktop.commandAgentHtml || !desktop.stopAgentHtml || !desktop.onAgentHtml)
    throw new VisualUnavailable("Update Canopy to open this visual.");

  const id = crypto.randomUUID();
  const surface = document.createElement("div");
  surface.className = "relative min-w-0";
  const canvas = previewCanvas(options.title);
  surface.append(canvas);
  container.append(surface);

  let closed = false;
  let width = Math.max(1, Math.min(1600, Math.round(container.clientWidth)));

  let height = clampVisualHeight(
    options.initialHeight || VISUAL_LIMITS.defaultHeight,
    Math.min(1000, options.maxHeight),
  );

  surface.style.height = `${height}px`;

  const send = (command: DesktopHtmlCommand) => {
    if (closed) return;
    void desktop.commandAgentHtml?.(id, command).catch(() => fail());
  };

  const host = (message: HostMessage) => send({ type: "host", message });

  const input = bindDesktopHtmlInput(
    surface,
    canvas,
    () => ({ width, height }),
    send,
    () => options.onEscape?.(),
  );

  const stopEvents = desktop.onAgentHtml((event) => {
    if (closed || event.id !== id) return;

    if (event.type === "frame") void paint(event);
    else if (event.type === "height") resize(width, clampVisualHeight(event.height, Math.min(1000, options.maxHeight)));
    else if (event.type === "escape") options.onEscape?.();
    else if (event.type === "replaced") options.onReplaced?.();
    else if (event.type === "error") fail(event.message);
  });

  const resizeObserver = new ResizeObserver(() =>
    resize(Math.max(1, Math.min(1600, Math.round(container.clientWidth))), height),
  );

  resizeObserver.observe(container);
  const stopTheme = onVisualThemeChange(() => host({ type: "theme", theme: currentVisualTheme() }));
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const onMotion = () => host({ type: "reduced_motion", reduced: motion.matches });
  motion.addEventListener("change", onMotion);
  options.signal?.addEventListener("abort", destroy, { once: true });

  function fail(message = "Couldn't open this visual.") {
    if (closed) return;
    destroy();
    options.onError(message);
  }

  function resize(nextWidth: number, nextHeight: number) {
    if (closed || (nextWidth === width && nextHeight === height)) return;
    width = nextWidth;
    height = nextHeight;
    surface.style.height = `${height}px`;
    options.onHeight(height);
    send({ type: "resize", width, height });
  }

  async function paint(event: Extract<DesktopHtmlEvent, { type: "frame" }>) {
    let bitmap: ImageBitmap | undefined;

    try {
      bitmap = await createImageBitmap(new Blob([new Uint8Array(event.png)], { type: "image/png" }));

      if (closed) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    } catch {
      fail();
    } finally {
      bitmap?.close();
      send({ type: "ack" });
    }
  }

  function destroy() {
    if (closed) return;
    closed = true;
    resizeObserver.disconnect();
    stopEvents();
    stopTheme();
    motion.removeEventListener("change", onMotion);
    options.signal?.removeEventListener("abort", destroy);
    input.destroy();
    reportEmbedHover(surface, false);
    surface.remove();
    void desktop?.stopAgentHtml?.(id).catch(() => {});
  }

  try {
    await desktop.startAgentHtml({
      id,
      specJson: options.specJson,
      title: options.title,
      width,
      height,
      theme: currentVisualTheme(),
    });
    send({ type: "resize", width, height });
    host({ type: "theme", theme: currentVisualTheme() });
    host({ type: "reduced_motion", reduced: prefersReducedMotion() });
    options.onHeight(height);
  } catch (error) {
    destroy();
    throw error;
  }

  return {
    frame: surface,
    visible: (visible) => {
      input.active(visible);
      host({ type: "visibility", visible });
    },
    reset: () => host({ type: "reset" }),
    destroy,
  };
}
