import { useCallback, useEffect, useRef, type ComponentRef } from "react";
import { View } from "react-native";
import { useAnimatedScrollHandler, useComposedEventHandler, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { useFollowingList } from "../../ui/useFollowingList";
import type { ThreadCreation } from "./thread-creations";

/** Keep the prompt's viewport coordinate, including negative coordinates when reading below a long prompt. */
export function usePreparationAnchor(
  job: ThreadCreation,
  following: ReturnType<typeof useFollowingList<ThreadCreation>>,
) {
  const prompt = useRef<ComponentRef<typeof View>>(null);
  const initial = useRef(job.preparationAnchor);
  const mounted = useRef(true);
  const frame = useRef(0);
  const attempts = useRef(0);
  const lastCapture = useSharedValue(0);

  const measure = useCallback(
    (capture = false) => {
      if (!mounted.current) return;
      following.list.current?.getNativeScrollRef()?.measureInWindow((_x: number, edge: number) => {
        prompt.current?.measureInWindow((_x, top, _w, height) => {
          if (!mounted.current || !height) return;
          const target = initial.current ?? (!following.isFollowing() ? job.preparationAnchor : undefined);

          if (!target || capture || !following.reader.idle()) {
            job.preparationAnchor = { top: top - edge };
            attempts.current = 0;

            return;
          }

          const delta = top - edge - target.top;

          if (Math.abs(delta) < 1 || attempts.current++ >= 60) {
            initial.current = undefined;
            job.preparationAnchor = { top: top - edge };
            attempts.current = 0;

            return;
          }

          following.restoreReading(following.scrollY.get() - delta);
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(() => measure());
        });
      });
    },
    [following, job],
  );

  const layout = useCallback(() => measure(), [measure]);
  const captureReader = useCallback(() => measure(true), [measure]);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      cancelAnimationFrame(frame.current);
    };
  }, []);

  const capture = useAnimatedScrollHandler({
    onScroll: () => {
      const now = Date.now();

      if (now - lastCapture.get() < 100) return;
      lastCapture.set(now);
      scheduleOnRN(layout);
    },
    onEndDrag: () => scheduleOnRN(captureReader),
    onMomentumEnd: () => scheduleOnRN(captureReader),
  });

  return { prompt, measure: layout, onScroll: useComposedEventHandler([following.listProps.onScroll, capture]) };
}
