import { useMemo, useRef, useState } from "react";
import { Image, PanResponder, View, type GestureResponderEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";

const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));

function fingers(event: GestureResponderEvent) {
  const [a, b] = event.nativeEvent.touches;

  return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
}

/** Direct manipulation has no momentum or decorative motion. Swipe down at the fitted size dismisses. */
export function ImageCanvas({ uri, name, onClose }: { uri: string; name: string; onClose: () => void }) {
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const start = useRef({ scale: 1, x: 0, y: 0, distance: 0, dx: 0, dy: 0 });

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
          } else if (s.distance) {
            s.distance = 0;
            s.x = x.get();
            s.y = y.get();
            s.dx = gesture.dx;
            s.dy = gesture.dy;
          } else {
            x.set(clamp(s.x + gesture.dx - s.dx, (bounds.width * (scale.get() - 1)) / 2));
            y.set(clamp(s.y + gesture.dy - s.dy, (bounds.height * (scale.get() - 1)) / 2));
          }
        },
        onPanResponderRelease: (_event, gesture) => {
          if (scale.get() === 1 && gesture.dy > 100 && Math.abs(gesture.dx) < 80) onClose();
          x.set(clamp(x.get(), (bounds.width * (scale.get() - 1)) / 2));
          y.set(clamp(y.get(), (bounds.height * (scale.get() - 1)) / 2));
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderTerminate: () => {
          scale.set(1);
          x.set(0);
          y.set(0);
        },
      }),
    [bounds, onClose, scale, x, y],
  );

  return (
    <View
      style={{ flex: 1, overflow: "hidden" }}
      onLayout={(event) => setBounds(event.nativeEvent.layout)}
      {...responder.panHandlers}
    >
      <Animated.View style={[{ flex: 1 }, transform]}>
        <Image
          source={{ uri }}
          accessibilityLabel={name}
          resizeMode="contain"
          style={{ width: "100%", height: "100%" }}
        />
      </Animated.View>
    </View>
  );
}
