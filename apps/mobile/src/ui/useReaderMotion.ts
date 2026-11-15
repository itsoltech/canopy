import { useMemo } from "react";
import { useSharedValue, type SharedValue } from "react-native-reanimated";

/** A released finger may still start a fling: its first frames are the reader's too. */
const RELEASE_GRACE_MS = 300;

/**
 * Who moves a chat feed: the reader's finger or its fling (and, briefly, a released finger), an animated return to
 * the end, or neither (layout and the feed's own corrections). Scroll handlers report gestures here; all worklets.
 */
export function useReaderMotion(anchoring: SharedValue<boolean>) {
  const gesture = useSharedValue(false);
  const released = useSharedValue(0);
  // An animated return to the end ("Show latest") is underway.
  const seeking = useSharedValue(false);

  return useMemo(
    () => ({
      begin: () => {
        "worklet";
        gesture.set(true);
        seeking.set(false);
        anchoring.set(false);
      },
      momentum: () => {
        "worklet";
        gesture.set(true);
      },
      end: () => {
        "worklet";
        gesture.set(false);
        released.set(Date.now());
      },
      seek: (animated: boolean) => {
        "worklet";
        seeking.set(animated);
      },
      arrived: () => {
        "worklet";
        seeking.set(false);
      },
      /** Nobody is moving the feed on purpose: any movement now is layout. */
      idle: () => {
        "worklet";

        return !gesture.get() && !seeking.get() && Date.now() - released.get() > RELEASE_GRACE_MS;
      },
    }),
    [gesture, released, seeking, anchoring],
  );
}
