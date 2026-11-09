import { createContext, useContext, useEffect, useRef, useState, type ComponentRef } from "react";
import { View, useWindowDimensions } from "react-native";

/** Mounted list windows can contain off-screen images, including many images inside one tall turn. */
export class ImageViewport {
  #readers = new Set<() => void>();
  #frame: number | undefined;

  register(read: () => void) {
    this.#readers.add(read);
    this.refresh();

    return () => {
      this.#readers.delete(read);

      if (!this.#readers.size && this.#frame !== undefined) {
        cancelAnimationFrame(this.#frame);
        this.#frame = undefined;
      }
    };
  }

  refresh = () => {
    if (this.#frame !== undefined || !this.#readers.size) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;

      for (const read of this.#readers) read();
    });
  };
}

export const ImageViewportContext = createContext<ImageViewport | null>(null);

/** Outside a timeline (composer and viewer), an explicitly opened image is immediately eligible. */
export function useImageVisibility() {
  const viewport = useContext(ImageViewportContext);
  const ref = useRef<ComponentRef<typeof View>>(null);
  const { height, width } = useWindowDimensions();
  const [visible, setVisible] = useState(!viewport);

  useEffect(() => {
    if (!viewport) return;
    let active = true;

    const unregister = viewport.register(() => {
      ref.current?.measureInWindow((x, y, w, h) => {
        if (active) setVisible(w > 0 && h > 0 && x < width && x + w > 0 && y < height && y + h > 0);
      });
    });

    return () => {
      active = false;
      unregister();
    };
  }, [viewport, height, width]);

  return { ref, visible: !viewport || visible, onLayout: viewport?.refresh };
}
