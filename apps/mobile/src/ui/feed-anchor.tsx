import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { View, type FlatListProps } from "react-native";
import Animated, {
  measure,
  scrollTo,
  useAnimatedRef,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import type { ui } from "@canopy/contracts";
import type { useFollowingList } from "./useFollowingList";
import { motion, useReducedMotion } from "./motion";
import { disclosureOffset, disclosurePosition } from "./disclosure-anchor";

/** One tapped header owns the manual disclosure transition. */
class AnchorSession {
  #version = 0;
  #manual = false;
  #listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  manual = () => this.#manual;

  begin() {
    this.#version++;
    this.#manual = true;
    this.#emit();

    return this.#version;
  }

  end(version: number) {
    if (!this.#manual || version !== this.#version) return;
    this.#manual = false;
    this.#emit();
  }

  #emit() {
    for (const listener of this.#listeners) listener();
  }
}

export function useFeedAnchor({
  list,
  scrollY,
  minimum,
  corrections,
  anchoring,
  track,
}: ReturnType<typeof useFollowingList<ui.Turn>>) {
  const generation = useSharedValue(0);
  const [session] = useState(() => new AnchorSession());

  const geometry = useMemo(
    () => ({ list, scrollY, minimum, corrections, anchoring, generation, track }),
    [list, scrollY, minimum, corrections, anchoring, generation, track],
  );

  return useMemo(() => ({ session, geometry }), [session, geometry]);
}

const Anchor = createContext<ReturnType<typeof useFeedAnchor> | null>(null);
const idle = new AnchorSession();
const Cell = createContext<ReturnType<typeof useAnimatedRef<View>> | null>(null);

/** Preserve FlatList's inversion style and layout notifications; expose its actual cell geometry. */
export function FeedAnchorCell({
  children,
  style,
  onLayout,
  onFocusCapture,
}: React.ComponentProps<NonNullable<FlatListProps<ui.Turn>["CellRendererComponent"]>>) {
  const cell = useAnimatedRef<View>();

  return (
    <Cell.Provider value={cell}>
      <Animated.View ref={cell} collapsable={false} style={style} onLayout={onLayout} onFocusCapture={onFocusCapture}>
        {children}
      </Animated.View>
    </Cell.Provider>
  );
}

/** Both page measurements contain the same scroll checkpoint, which cancels in their difference. */
function correctHeader(
  geometry: ReturnType<typeof useFeedAnchor>["geometry"],
  origin: SharedValue<{ offset: number; position: number }>,
  after: number,
) {
  "worklet";
  const start = origin.get();
  const next = disclosureOffset(start.offset, start.position, after, geometry.minimum.get());
  const delta = next - geometry.scrollY.get();

  if (Math.abs(delta) < 0.5) return true;
  geometry.scrollY.set(next);
  geometry.corrections.set(geometry.corrections.get() + 1);
  scrollTo(geometry.list, 0, next, false);

  return false;
}

export function FeedAnchorProvider({
  value,
  children,
}: {
  value: ReturnType<typeof useFeedAnchor>;
  children: ReactNode;
}) {
  return <Anchor.Provider value={value}>{children}</Anchor.Provider>;
}

/** Only the list wrapper subscribes; starting a toggle does not replace turn props or the data array. */
export function useManualFeedAnchor() {
  const session = useContext(Anchor)?.session ?? idle;

  return useSyncExternalStore(session.subscribe, session.manual);
}

/**
 * Synchronous UI geometry replaces delayed JS measurements of possibly clipped cells. Only the tapped
 * header's frame callback runs. A drag cancels the correction; a newer tap supersedes the older session.
 */
export function useAnchoredToggle() {
  const anchor = useContext(Anchor);
  const cell = useContext(Cell);
  const header = useAnimatedRef<View>();
  const reduced = useReducedMotion();
  const origin = useSharedValue({ offset: 0, position: 0 });
  const started = useSharedValue(0);
  const version = useSharedValue(0);
  const stable = useSharedValue(0);
  const active = useSharedValue(false);
  // Keep class instances and JS listeners out of the worklet closure.
  const geometry = anchor?.geometry;

  const finish = (id: number) => {
    if (version.get() === id) frames.setActive(false);
    anchor?.session.end(id);

    if (!geometry) return;
    scheduleOnUI(() => {
      if (geometry.generation.get() !== id) return;
      geometry.anchoring.set(false);
      geometry.track(geometry.scrollY.get());
    });
  };

  const frames = useFrameCallback(() => {
    "worklet";

    if (!geometry || !cell || !active.get()) return;
    const box = measure(header);
    const frame = measure(cell);

    if (!geometry.anchoring.get() || geometry.generation.get() !== version.get() || !box || !frame || box.height <= 0) {
      active.set(false);
      scheduleOnRN(finish, version.get());

      return;
    }

    const position = disclosurePosition(frame.y, frame.height, frame.pageY, box.pageY);
    stable.set(correctHeader(geometry, origin, position) ? stable.get() + 1 : 0);

    const elapsed = Date.now() - started.get();

    if ((elapsed >= (reduced ? 0 : motion.fast) && stable.get() >= 2) || elapsed >= motion.fast + motion.slow) {
      active.set(false);
      geometry.anchoring.set(false);
      scheduleOnRN(finish, version.get());
    }
  }, false);

  useEffect(
    () => () => {
      frames.setActive(false);
      anchor?.session.end(version.get());

      if (!geometry) return;
      scheduleOnUI(() => {
        if (geometry.generation.get() === version.get()) geometry.anchoring.set(false);
      });
    },
    [frames, anchor, version, geometry],
  );

  return {
    header,
    toggle(change: () => void) {
      if (!anchor || !geometry || !cell) return change();
      const id = anchor.session.begin();
      frames.setActive(true);
      scheduleOnUI(() => {
        const box = measure(header);
        const frame = measure(cell);
        version.set(id);
        geometry.generation.set(id);
        stable.set(0);
        started.set(Date.now());
        active.set(Boolean(box && frame && box.height > 0));
        geometry.anchoring.set(active.get());

        if (box && frame)
          origin.set({
            offset: geometry.scrollY.get(),
            position: disclosurePosition(frame.y, frame.height, frame.pageY, box.pageY),
          });
        scheduleOnRN(change);

        if (!active.get()) scheduleOnRN(finish, id);
      });
    },
  };
}
