import { useLayoutEffect } from "react";
import {
  cancelAnimation,
  useAnimatedReaction,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { motion, smoothOut, useReducedMotion } from "../../ui/motion";
import { clamp, MAX_SCALE, zoomAround, type Point, type Size } from "../attachments/image-zoom";

export type PreviewGeometry = { viewport: Size; fitted: Size };

export type PreviewTransform = { scale: number; offset: Point };

function fit(viewport: Size, frame: Size): PreviewGeometry {
  "worklet";

  const scale =
    frame.width && frame.height ? Math.min(viewport.width / frame.width, viewport.height / frame.height, 1) : 0;

  return { viewport, fitted: { width: frame.width * scale, height: frame.height * scale } };
}

export function sameGeometry(a: PreviewGeometry, b: PreviewGeometry) {
  "worklet";

  return (
    a.viewport.width === b.viewport.width &&
    a.viewport.height === b.viewport.height &&
    a.fitted.width === b.fitted.width &&
    a.fitted.height === b.fitted.height
  );
}

/** Invert the local zoom and translation before sending a point to the remote app. */
export function remotePoint(point: Point, { viewport, fitted }: PreviewGeometry, { scale, offset }: PreviewTransform) {
  "worklet";

  return {
    x: 0.5 + (point.x - viewport.width / 2 - offset.x) / (fitted.width * scale),
    y: 0.5 + (point.y - viewport.height / 2 - offset.y) / (fitted.height * scale),
  };
}

export function usePreviewZoom(width: number, height: number) {
  const reduced = useReducedMotion();
  const viewport = useSharedValue<Size>({ width: 0, height: 0 });
  const frame = useSharedValue<Size>({ width, height });
  const geometry = useDerivedValue(() => fit(viewport.get(), frame.get()));
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);

  useLayoutEffect(() => {
    frame.set({ width, height });
  }, [frame, width, height]);

  const read = (): PreviewTransform => {
    "worklet";

    return { scale: scale.get(), offset: { x: x.get(), y: y.get() } };
  };

  const stop = () => {
    "worklet";
    cancelAnimation(scale);
    cancelAnimation(x);
    cancelAnimation(y);
  };

  const place = (next: number, offset: Point, animate: boolean) => {
    "worklet";
    const { fitted, viewport } = geometry.get();
    const tx = clamp(offset.x, Math.max(0, (fitted.width * next - viewport.width) / 2));
    const ty = clamp(offset.y, Math.max(0, (fitted.height * next - viewport.height) / 2));
    const config = { duration: motion.fast, easing: smoothOut };
    scale.set(animate && !reduced ? withTiming(next, config) : next);
    x.set(animate && !reduced ? withTiming(tx, config) : tx);
    y.set(animate && !reduced ? withTiming(ty, config) : ty);
  };

  const zoom = (next: number, from: Point, to: Point, options?: { animate?: boolean; base?: PreviewTransform }) => {
    "worklet";
    const { viewport } = geometry.get();
    const centre = { x: viewport.width / 2, y: viewport.height / 2 };
    const current = options?.base ?? read();
    const target = Math.min(MAX_SCALE, Math.max(1, next));

    const offset = zoomAround(
      { x: from.x - centre.x, y: from.y - centre.y },
      { x: to.x - centre.x, y: to.y - centre.y },
      current.offset,
      current.scale,
      target,
    );

    place(target, offset, options?.animate ?? false);
  };

  useAnimatedReaction(
    () => geometry.get(),
    (area, previous) => {
      if (!previous || sameGeometry(area, previous)) return;
      const { scale, offset } = read();
      place(scale, offset, false);
    },
  );

  const adjust = (action: string) => {
    "worklet";
    const { viewport } = geometry.get();
    const centre = { x: viewport.width / 2, y: viewport.height / 2 };
    const current = scale.get();
    zoom(action === "reset" ? 1 : current + (action === "increment" ? 1 : -1), centre, centre, { animate: true });
  };

  return { viewport, geometry, read, stop, zoom, adjust };
}

export type PreviewZoom = ReturnType<typeof usePreviewZoom>;
