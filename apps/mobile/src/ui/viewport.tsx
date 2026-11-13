import { createContext, useContext, useEffect, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { View, useWindowDimensions } from "react-native";

/** One scroll-driven measurement queue for images and animation loops in the mounted list window. */
export class Viewport {
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

export const ViewportContext = createContext<Viewport | null>(null);
const DisclosureVisibility = createContext(true);

export function useVisibility() {
  return useContext(DisclosureVisibility);
}

/** Retained accordion bodies stop clocks and decorative loops while clipped closed. */
export function VisibilityScope({ visible, children }: { visible: boolean; children: ReactNode }) {
  const parent = useContext(DisclosureVisibility);

  return <DisclosureVisibility.Provider value={parent && visible}>{children}</DisclosureVisibility.Provider>;
}

/** Outside a timeline, mounted controls are eligible immediately. No continuous JS/rAF loop. */
export function useViewportVisibility() {
  const viewport = useContext(ViewportContext);
  const disclosed = useVisibility();
  const ref = useRef<ComponentRef<typeof View>>(null);
  const { height, width } = useWindowDimensions();
  const [visible, setVisible] = useState(!viewport);

  useEffect(() => {
    if (!viewport || !disclosed) return;
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
  }, [viewport, height, width, disclosed]);

  return { ref, visible: disclosed && (!viewport || visible), onLayout: disclosed ? viewport?.refresh : undefined };
}
