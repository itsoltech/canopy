import { useCallback, useMemo, useRef, useState } from "react";
import { Image, PanResponder, View, type GestureResponderEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";

const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));

type Size = { width: number; height: number };

/** Contain leaves letterboxing. Bound the actual fitted image, including after orientation changes. */
function panLimits(viewport: Size, image: Size, scale: number) {
  const fit = image.width && image.height ? Math.min(viewport.width / image.width, viewport.height / image.height) : 1;

  return {
    x: Math.max(0, ((image.width || viewport.width) * fit * scale - viewport.width) / 2),
    y: Math.max(0, ((image.height || viewport.height) * fit * scale - viewport.height) / 2),
  };
}

function fingers(event: GestureResponderEvent) {
  const [a, b] = event.nativeEvent.touches;

  return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
}

/** Direct manipulation has no momentum or decorative motion. Swipe down at the fitted size dismisses. */
export function ImageCanvas({
  uri,
  name,
  onClose,
  onError,
}: {
  uri: string;
  name: string;
  onClose: () => void;
  onError: () => void;
}) {
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const picture = useRef<Size>({ width: 0, height: 0 });
  const start = useRef({ scale: 1, x: 0, y: 0, distance: 0, dx: 0, dy: 0 });

  const settle = useCallback(
    (area = bounds) => {
      const limit = panLimits(area, picture.current, scale.get());
      x.set(clamp(x.get(), limit.x));
      y.set(clamp(y.get(), limit.y));
    },
    [bounds, scale, x, y],
  );

  const transform = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }],
  }));

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          start.current = { scale: scale.get(), x: x.get(), y: y.get(), distance: fingers(event), dx: 0, dy: 0 };
        },
        onPanResponderMove: (event, gesture) => {
          const distance = fingers(event);
          const s = start.current;

          if (distance) {
            if (!s.distance) {
              s.distance = distance;
              s.scale = scale.get();
            }

            scale.set(Math.max(1, Math.min(6, (s.scale * distance) / s.distance)));
            settle();
          } else if (s.distance) {
            s.distance = 0;
            s.x = x.get();
            s.y = y.get();
            s.dx = gesture.dx;
            s.dy = gesture.dy;
          } else {
            const limit = panLimits(bounds, picture.current, scale.get());
            x.set(clamp(s.x + gesture.dx - s.dx, limit.x));
            y.set(clamp(s.y + gesture.dy - s.dy, limit.y));
          }
        },
        onPanResponderRelease: (_event, gesture) => {
          if (scale.get() === 1 && gesture.dy > 100 && Math.abs(gesture.dx) < 80) onClose();
          settle();
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderTerminate: () => {
          scale.set(1);
          x.set(0);
          y.set(0);
        },
      }),
    [bounds, onClose, scale, x, y, settle],
  );

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={name}
      accessibilityHint="Adjust to zoom. Swipe down at the original size to close."
      accessibilityActions={[
        { name: "increment", label: "Zoom in" },
        { name: "decrement", label: "Zoom out" },
        { name: "reset", label: "Reset zoom" },
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "reset") {
          scale.set(1);
          x.set(0);
          y.set(0);
        } else scale.set(Math.max(1, Math.min(6, scale.get() + (nativeEvent.actionName === "increment" ? 1 : -1))));
        settle();
      }}
      style={{ flex: 1, overflow: "hidden" }}
      onLayout={(event) => {
        setBounds(event.nativeEvent.layout);
        settle(event.nativeEvent.layout);
      }}
      {...responder.panHandlers}
    >
      <Animated.View style={[{ flex: 1 }, transform]}>
        <Image
          source={{ uri }}
          onError={onError}
          onLoad={(event) => {
            picture.current = event.nativeEvent.source;
            settle();
          }}
          accessibilityLabel={name}
          resizeMode="contain"
          style={{ width: "100%", height: "100%" }}
        />
      </Animated.View>
    </View>
  );
}
