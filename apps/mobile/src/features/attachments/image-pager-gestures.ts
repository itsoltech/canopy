import { usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture } from "react-native-gesture-handler";
import { useSharedValue, withDecay, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { ImagePagerModel } from "./image-pager-model";
import { clamp, DOUBLE_TAP_SCALE, MAX_SCALE, MIN_PINCH, resist, zoomAround, type Point } from "./image-zoom";

/** How far (share of the width) or how fast (points per second) a swipe must go to turn the page. */
const PAGE_SHARE = 0.25;
const PAGE_VELOCITY = 500;

/** How far or how fast a vertical drag at the fitted size must go to close the viewer. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 800;
const ZOOMED = 1.01;

const Mode = { none: 0, pan: 1, page: 2, dismiss: 3 } as const;

/**
 * Swipe sideways to turn pages, pinch or double-tap to zoom, pan a zoomed image (past its edge it pulls the
 * neighbour in) and drag at the fitted size up or down to close. Fingers move content directly; only settling
 * animates, and with reduced motion settling is instant.
 */
export function useImagePagerGestures(model: ImagePagerModel, onClose: () => void) {
  const mode = useSharedValue<number>(Mode.none);
  const pinching = useSharedValue(false);
  const pinch = usePinch(model, mode, pinching);
  const pan = usePan(model, mode, pinching, onClose);
  const doubleTap = useDoubleTap(model);

  return useSimultaneousGestures(pinch, pan, doubleTap);
}

function centred(model: ImagePagerModel, x: number, y: number): Point {
  "worklet";
  const { width, height } = model.viewport.get();

  return { x: x - width / 2, y: y - height / 2 };
}

/** Settles a zoom of `next` around `focal`, inside the image's bounds. */
function zoomTo(model: ImagePagerModel, focal: Point, next: number) {
  "worklet";
  const moved = zoomAround(focal, focal, { x: model.x.get(), y: model.y.get() }, model.scale.get(), next);
  const limit = model.limits(next);
  model.scale.set(model.settle(next));
  model.x.set(model.settle(clamp(moved.x, limit.x)));
  model.y.set(model.settle(clamp(moved.y, limit.y)));
}

function usePinch(model: ImagePagerModel, mode: SharedValue<number>, pinching: SharedValue<boolean>) {
  const start = useSharedValue({ base: 0, scale: 1, offset: { x: 0, y: 0 }, focal: { x: 0, y: 0 } });

  return usePinchGesture({
    onActivate: () => {
      "worklet";
      model.claim();
      pinching.set(true);
      mode.set(Mode.pan);
      start.set({ ...start.get(), base: 0 });

      if (model.drag.get()) model.drag.set(model.settle(0));
      model.dismissX.set(model.settle(0));
      model.dismissY.set(model.settle(0));
    },
    onUpdate: (event) => {
      "worklet";

      // As the first finger lifts, the focal point jumps to the one left; the image must not follow it.
      if (event.numberOfPointers < 2) return;
      const focal = centred(model, event.focalX, event.focalY);

      // Activation carries no fingers yet: the first update is the baseline.
      if (!start.get().base) {
        start.set({
          base: event.scale || 1,
          scale: model.scale.get(),
          offset: { x: model.x.get(), y: model.y.get() },
          focal,
        });
      }

      const from = start.get();
      const next = Math.min(MAX_SCALE, Math.max(MIN_PINCH, (from.scale * event.scale) / from.base));
      const moved = zoomAround(from.focal, focal, from.offset, from.scale, next);
      model.scale.set(next);
      model.x.set(moved.x);
      model.y.set(moved.y);
    },
    onDeactivate: (event) => {
      "worklet";
      zoomTo(model, centred(model, event.focalX, event.focalY), Math.min(MAX_SCALE, Math.max(1, model.scale.get())));
    },
    onFinalize: () => {
      "worklet";
      pinching.set(false);
    },
  });
}

function usePan(
  model: ImagePagerModel,
  mode: SharedValue<number>,
  pinching: SharedValue<boolean>,
  onClose: () => void,
) {
  return usePanGesture({
    minDistance: 8,
    onActivate: () => {
      "worklet";
      model.claim();
      mode.set(pinching.get() || model.scale.get() > ZOOMED ? Mode.pan : Mode.none);
    },
    onUpdate: (event) => {
      "worklet";
      const active = model.active.get();

      // Activation carries no travel yet: the first movement picks paging or dismissing.
      if (mode.get() === Mode.none && (event.translationX || event.translationY))
        mode.set(Math.abs(event.translationX) > Math.abs(event.translationY) ? Mode.page : Mode.dismiss);
      const current = mode.get();

      if (current === Mode.page) {
        const neighbour = model.hasPage(active - Math.sign(event.translationX));
        model.drag.set(neighbour ? event.translationX : resist(event.translationX));
      } else if (current === Mode.dismiss) {
        model.dismissX.set(event.translationX);
        model.dismissY.set(event.translationY);
      } else if (current === Mode.pan && !pinching.get()) {
        const limit = model.limits(model.scale.get());
        // Past the image's edge the drag spills into the strip and pulls the neighbour in.
        const x = model.x.get() + model.drag.get() + event.changeX;
        const kept = clamp(x, limit.x);
        const spill = x - kept;
        model.x.set(kept);
        model.y.set(clamp(model.y.get() + event.changeY, limit.y));
        model.drag.set(spill && model.hasPage(active - Math.sign(spill)) ? spill : 0);
      }
    },
    onDeactivate: (event) => {
      "worklet";
      const current = mode.get();
      mode.set(Mode.none);

      if (current === Mode.dismiss) {
        release(model, event.velocityY, !event.canceled, onClose);

        return;
      }

      const shift = model.drag.get();
      const fast = Math.abs(event.velocityX) > PAGE_VELOCITY && Math.sign(event.velocityX) === Math.sign(shift);
      const far = Math.abs(shift) > model.viewport.get().width * PAGE_SHARE;
      const direction = shift < 0 ? 1 : -1;

      if (!event.canceled && shift && (far || fast) && model.hasPage(model.active.get() + direction)) {
        model.turn(direction);

        return;
      }

      if (shift) model.drag.set(model.settle(0));

      if (current === Mode.pan && !pinching.get() && !model.reduced) {
        const limit = model.limits(model.scale.get());
        model.x.set(withDecay({ velocity: shift ? 0 : event.velocityX, clamp: [-limit.x, limit.x] }));
        model.y.set(withDecay({ velocity: event.velocityY, clamp: [-limit.y, limit.y] }));
      }
    },
  });
}

/** Far or fast enough, the image leaves the way it was dragged and the viewer closes; otherwise it returns. */
function release(model: ImagePagerModel, velocity: number, completed: boolean, onClose: () => void) {
  "worklet";
  const y = model.dismissY.get();
  const flung = Math.abs(velocity) > DISMISS_VELOCITY && Math.sign(velocity) === Math.sign(y);

  if (!completed || (Math.abs(y) < DISMISS_DISTANCE && !flung)) {
    model.dismissX.set(model.settle(0));
    model.dismissY.set(model.settle(0));

    return;
  }

  model.dismissY.set(
    model.settle(Math.sign(y) * model.viewport.get().height, (finished) => {
      if (finished) scheduleOnRN(onClose);
    }),
  );
}

function useDoubleTap(model: ImagePagerModel) {
  return useTapGesture({
    numberOfTaps: 2,
    onActivate: (event) => {
      "worklet";
      model.claim();
      zoomTo(model, centred(model, event.x, event.y), model.scale.get() > ZOOMED ? 1 : DOUBLE_TAP_SCALE);
    },
  });
}
