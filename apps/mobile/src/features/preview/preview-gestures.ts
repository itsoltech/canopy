import { Platform } from "react-native";
import { GestureStateManager, useManualGesture, type TouchData } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { DOUBLE_TAP_SCALE, type Point } from "../attachments/image-zoom";
import {
  remotePoint,
  sameGeometry,
  type PreviewGeometry,
  type PreviewTransform,
  type PreviewZoom,
} from "./preview-zoom";

const TAP_TRAVEL = 8;
const TAP_DURATION = 250;
const DOUBLE_TAP_GAP = 300;
const DOUBLE_TAP_TRAVEL = 32;

type PinchPosition = { centre: Point; span: number };

type Touch =
  | { kind: "remote"; id: number; start: Point; geometry: PreviewGeometry; transform: PreviewTransform }
  | { kind: "pan"; last: Point; start: Point; tapStartedAt?: number }
  | { kind: "pinch"; base?: PinchPosition & { transform: PreviewTransform } };

function distance(a: Point, b: Point) {
  "worklet";

  return Math.hypot(a.x - b.x, a.y - b.y);
}

function point({ x, y }: TouchData): Point {
  "worklet";

  return { x, y };
}

function pinchPosition(a: TouchData, b: TouchData): PinchPosition {
  "worklet";

  return { centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, span: Math.max(1, distance(a, b)) };
}

function localTouch(touches: readonly TouchData[], transform?: PreviewTransform): Touch | undefined {
  "worklet";
  const [a, b] = touches;

  if (!a) return;

  if (!b) return { kind: "pan", start: point(a), last: point(a) };

  return { kind: "pinch", base: transform ? { ...pinchPosition(a, b), transform } : undefined };
}

/** A remote pointer is committed only when the entire touch was single-finger and ended normally. */
export function usePreviewGestures(
  model: PreviewZoom,
  enabled: boolean,
  inspecting: boolean,
  sendPointer: (from: Point, to: Point, drag: boolean) => void,
) {
  const touch = useSharedValue<Touch | undefined>(undefined);
  const lastTap = useSharedValue<{ point: Point; time: number } | undefined>(undefined);
  const { geometry, read, stop, zoom } = model;
  const android = Platform.OS === "android";

  const moveLocal = (touches: readonly TouchData[]) => {
    "worklet";
    const current = touch.get();
    const [first, second] = touches;

    if (!current || !first) return;

    if (current.kind === "pinch" && second) {
      const next = pinchPosition(first, second);
      const base = current.base;

      // Use the original focal point even when some intermediate offsets hit the bounds.
      if (base)
        zoom((base.transform.scale * next.span) / base.span, base.centre, next.centre, { base: base.transform });
      else touch.set({ kind: "pinch", base: { ...next, transform: read() } });
    } else if (current.kind === "pan" && !second) {
      const last = point(first);

      const tapStartedAt =
        current.tapStartedAt !== undefined && distance(current.start, last) <= TAP_TRAVEL
          ? current.tapStartedAt
          : undefined;

      if (tapStartedAt === undefined) {
        lastTap.set(undefined);
        zoom(read().scale, current.tapStartedAt === undefined ? current.last : current.start, last);
      }

      touch.set({ ...current, last, tapStartedAt });
    }
  };

  return useManualGesture({
    enabled,
    shouldCancelWhenOutside: false,
    onBegin: ({ handlerTag }) => {
      "worklet";
      GestureStateManager.activate(handlerTag);
    },
    onTouchesDown: ({ allTouches }) => {
      "worklet";
      const [first, second] = allTouches;
      const current = touch.get();
      stop();

      if (second) {
        lastTap.set(undefined);
        // Android's pointer-down snapshot can hold stale positions for fingers already on the glass.
        touch.set(localTouch(allTouches, android ? undefined : read()));
      } else if (first && !current) {
        const start = point(first);

        if (!inspecting) lastTap.set(undefined);
        touch.set(
          inspecting
            ? { kind: "pan", start, last: start, tapStartedAt: Date.now() }
            : { kind: "remote", id: first.id, start, geometry: geometry.get(), transform: read() },
        );
      }
    },
    onTouchesMove: ({ allTouches }) => {
      "worklet";
      moveLocal(allTouches);
    },
    onTouchesUp: ({ allTouches, changedTouches, numberOfTouches, handlerTag }) => {
      "worklet";
      moveLocal(allTouches);
      const current = touch.get();

      if (numberOfTouches) {
        // allTouches still includes the lifted finger on both iOS and Android.
        touch.set(
          localTouch(
            allTouches.filter((pointer) => !changedTouches.some((lifted) => lifted.id === pointer.id)),
            read(),
          ),
        );
        lastTap.set(undefined);

        return;
      }

      const [end] = changedTouches;

      if (current?.kind === "remote" && end?.id === current.id && !inspecting) {
        releaseRemote(current, end, geometry.get(), sendPointer);
      } else if (current?.kind === "pan" && end && current.tapStartedAt !== undefined && inspecting) {
        const now = Date.now();
        const previous = lastTap.get();
        const at = point(end);
        const tap = now - current.tapStartedAt <= TAP_DURATION && distance(current.start, at) <= TAP_TRAVEL;

        if (
          tap &&
          previous &&
          now - previous.time <= DOUBLE_TAP_GAP &&
          distance(previous.point, at) <= DOUBLE_TAP_TRAVEL
        ) {
          zoom(read().scale > 1.01 ? 1 : DOUBLE_TAP_SCALE, at, at, { animate: true });
          lastTap.set(undefined);
        } else lastTap.set(tap ? { point: at, time: now } : undefined);
      } else lastTap.set(undefined);

      touch.set(undefined);
      GestureStateManager.deactivate(handlerTag);
    },
    onTouchesCancel: () => {
      "worklet";
      touch.set(undefined);
      lastTap.set(undefined);
    },
    onFinalize: ({ canceled }) => {
      "worklet";
      touch.set(undefined);

      if (canceled) lastTap.set(undefined);
    },
  });
}

function releaseRemote(
  touch: Extract<Touch, { kind: "remote" }>,
  end: Point,
  geometry: PreviewGeometry,
  sendPointer: (from: Point, to: Point, drag: boolean) => void,
) {
  "worklet";

  if (!sameGeometry(geometry, touch.geometry) || !geometry.fitted.width || !geometry.fitted.height) return;
  const from = remotePoint(touch.start, geometry, touch.transform);

  if (from.x < 0 || from.y < 0 || from.x > 1 || from.y > 1) return;
  const mapped = remotePoint(end, geometry, touch.transform);
  const to = { x: Math.min(1, Math.max(0, mapped.x)), y: Math.min(1, Math.max(0, mapped.y)) };
  const travel = Math.abs(to.x - from.x) * geometry.fitted.width + Math.abs(to.y - from.y) * geometry.fitted.height;
  scheduleOnRN(sendPointer, from, to, travel * touch.transform.scale > TAP_TRAVEL);
}
