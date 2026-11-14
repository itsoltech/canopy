import { useEffect, useState, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { motion, useTween } from "./motion";

/**
 * Accordion (web `expandGrid`): inline details grow and shrink with a fade on `fast`, the same both ways.
 * The height tweens from the measured content, so the parent reflows each frame and the rows below glide
 * instead of jumping. The content stays mounted until it has closed; instant with reduced motion. `style`
 * can cancel the parent's gap with a negative margin, so the closed accordion takes no space at all.
 */
export function Accordion({
  open,
  style: outer,
  children,
}: {
  open: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(open);
  const height = useSharedValue(0);
  const progress = useTween(open ? 1 : 0);

  useEffect(() => {
    if (open) {
      setShown(true);

      return;
    }

    const timer = setTimeout(() => setShown(false), motion.fast);

    return () => clearTimeout(timer);
  }, [open]);

  const style = useAnimatedStyle(() => ({ height: progress.get() * height.get(), opacity: progress.get() }));

  if (!open && !shown) return null;

  return (
    <Animated.View style={[{ overflow: "hidden" }, outer, style]}>
      <View
        style={{ position: "absolute", top: 0, left: 0, right: 0 }}
        onLayout={(event) => height.set(event.nativeEvent.layout.height)}
      >
        {children}
      </View>
    </Animated.View>
  );
}
