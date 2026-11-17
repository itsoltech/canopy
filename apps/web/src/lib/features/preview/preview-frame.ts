import type { AgentPreviewEvent } from "@canopy/contracts";

/** Decode off-screen and replace the previous image atomically; a pending decode never clears the canvas. */
export function paintPreviewFrame(
  canvas: HTMLCanvasElement,
  frame: AgentPreviewEvent,
  onpaint: (frame: AgentPreviewEvent) => void,
  onerror: (frame: AgentPreviewEvent) => void,
): () => void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(frame.data)], { type: frame.mimeType || "image/png" }));
  const image = new Image();
  let animation = 0;

  image.onload = () => {
    animation = requestAnimationFrame(() => {
      const context = canvas.getContext("2d");

      if (!context) {
        onerror(frame);

        return;
      }

      const width = frame.width || image.naturalWidth;
      const height = frame.height || image.naturalHeight;

      if (canvas.width !== width) canvas.width = width;

      if (canvas.height !== height) canvas.height = height;
      context.drawImage(image, 0, 0, width, height);
      URL.revokeObjectURL(url);
      onpaint(frame);
    });
  };

  image.onerror = () => {
    URL.revokeObjectURL(url);
    onerror(frame);
  };

  image.src = url;

  return () => {
    image.onload = image.onerror = null;
    cancelAnimationFrame(animation);
    URL.revokeObjectURL(url);
  };
}
