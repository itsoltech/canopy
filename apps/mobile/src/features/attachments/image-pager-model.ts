import { useEffect } from "react";
import { useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import { panLimits, type Size } from "./image-zoom";

/**
 * The pager on the UI thread. `page` is the strip's position in pages (fractional while it slides), `active` the
 * page gestures act on, `zoomed` the page that carries the zoom transform: after a page turn it may still be
 * sliding out, and the next gesture moves the zoom over (`claim`).
 */
export function useImagePagerModel(index: number, count: number, onIndexChange: (index: number) => void) {
  const reduced = useReducedMotion();
  const viewport = useSharedValue<Size>({ width: 0, height: 0 });
  const page = useSharedValue(index);
  const active = useSharedValue(index);
  const zoomed = useSharedValue(index);
  const total = useSharedValue(count);
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const drag = useSharedValue(0);
  const dismissX = useSharedValue(0);
  const dismissY = useSharedValue(0);
  const sizes = useSharedValue<Record<number, Size>>({});

  const settle = (value: number, done?: (finished?: boolean) => void) => {
    "worklet";

    if (!reduced) return withTiming(value, { duration: motion.fast, easing: smoothOut }, done);
    done?.(true);

    return value;
  };

  const resetZoom = () => {
    "worklet";
    scale.set(1);
    x.set(0);
    y.set(0);
  };

  const claim = () => {
    "worklet";

    if (zoomed.get() === active.get()) return;
    zoomed.set(active.get());
    resetZoom();
  };

  /** `area` stands in for a viewport the JS thread has just measured and not read back yet. */
  const limits = (next: number, area?: Size) => {
    "worklet";

    return panLimits(area ?? viewport.get(), sizes.get()[active.get()], next);
  };

  const hasPage = (target: number) => {
    "worklet";

    return target >= 0 && target < total.get();
  };

  /** Folds the finger's drag into the strip, then slides it to the neighbour. */
  const turn = (direction: number) => {
    "worklet";
    const target = active.get() + direction;
    page.set(page.get() - drag.get() / (viewport.get().width || 1));
    drag.set(0);
    active.set(target);
    page.set(settle(target, () => claim()));
    scheduleOnRN(onIndexChange, target);
  };

  useEffect(() => {
    total.set(count);
  }, [total, count]);

  // Buttons and before/after choices move the pager from outside; a swipe has already moved it.
  useEffect(() => {
    if (active.get() === index) return;
    const near = Math.abs(active.get() - index) === 1;
    active.set(index);
    zoomed.set(index);
    scale.set(1);
    x.set(0);
    y.set(0);
    drag.set(0);
    page.set(near && !reduced ? withTiming(index, { duration: motion.fast, easing: smoothOut }) : index);
  }, [index, reduced, active, zoomed, scale, x, y, drag, page]);

  return {
    reduced,
    viewport,
    page,
    active,
    zoomed,
    scale,
    x,
    y,
    drag,
    dismissX,
    dismissY,
    sizes,
    settle,
    resetZoom,
    claim,
    limits,
    hasPage,
    turn,
  };
}

export type ImagePagerModel = ReturnType<typeof useImagePagerModel>;
