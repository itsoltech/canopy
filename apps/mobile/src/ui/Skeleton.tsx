import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useReducedMotion } from "./motion";
import { useColors } from "./theme";

const Loading = createContext(false);

/** Keep the real layout mounted, but prevent interaction with values that have not loaded. */
export function SkeletonScope({ loading, children }: { loading: boolean; children: ReactNode }) {
  return <Loading.Provider value={loading}>{children}</Loading.Provider>;
}

export function useSkeleton() {
  return useContext(Loading);
}

/** Web's rounded, translucent pulse. Children reserve their exact measured size on both sides of loading. */
export function Skeleton({
  children,
  loading,
  style,
}: {
  children?: ReactNode;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const inherited = useSkeleton();
  const active = loading ?? (children ? inherited : true);
  const c = useColors();

  return (
    <View
      style={style}
      pointerEvents={active ? "none" : "auto"}
      accessibilityElementsHidden={active}
      importantForAccessibility={active ? "no-hide-descendants" : "auto"}
    >
      {children && <View style={{ opacity: active ? 0 : 1 }}>{children}</View>}
      {active && <SkeletonPulse dark={c.dark} />}
    </View>
  );
}

/** Mounted only while loading: ordinary controls do not subscribe to accessibility or start animation loops. */
function SkeletonPulse({ dark }: { dark: boolean }) {
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (reduced) {
      opacity.setValue(1);

      return;
    }

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.5,
          duration: 1000,
          easing: Easing.linear,
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 1000,
          easing: Easing.linear,
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );

    pulse.start();

    return () => pulse.stop();
  }, [reduced, opacity]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { borderRadius: 6, backgroundColor: dark ? "rgba(255,255,255,0.1)" : "rgba(9,9,11,0.05)", opacity },
      ]}
    />
  );
}

/** Compact list rows, also used before SecureStore has selected the paired screen. */
export function ListSkeleton({
  rows = 4,
  lines = 2,
  avatar = false,
  inset = true,
}: {
  rows?: number;
  lines?: 2 | 3;
  avatar?: boolean;
  inset?: boolean;
}) {
  return (
    <View style={{ gap: inset ? 0 : 12 }} accessibilityLabel="Loading" accessibilityState={{ busy: true }}>
      {Array.from({ length: rows }, (_, index) => (
        <View
          key={index}
          style={{
            paddingHorizontal: inset ? 12 : 0,
            paddingVertical: inset ? (lines === 3 ? 10 : 12) : 0,
            flexDirection: "row",
            gap: 12,
            alignItems: "center",
          }}
        >
          {avatar && <Skeleton style={{ width: 40, height: 40, borderRadius: 20 }} />}
          <View style={{ flex: 1, gap: lines === 3 || !inset ? 2 : 4 }}>
            <Skeleton style={{ height: lines === 3 ? 18 : 20, width: "70%" }} />
            <Skeleton style={{ height: lines === 3 ? 24 : 16, width: lines === 3 ? "90%" : "45%" }} />
            {lines === 3 && <Skeleton style={{ height: 18, width: "45%" }} />}
          </View>
        </View>
      ))}
    </View>
  );
}

/** The timeline keeps its own scroll viewport and composer mounted while the snapshot arrives. */
export function ConversationSkeleton() {
  return (
    <View style={{ gap: 24 }} accessibilityLabel="Loading conversation" accessibilityState={{ busy: true }}>
      <View style={{ alignItems: "flex-end", gap: 6 }}>
        <Skeleton style={{ width: "60%", height: 20 }} />
        <Skeleton style={{ width: "40%", height: 20 }} />
      </View>
      <View style={{ gap: 8 }}>
        <Skeleton style={{ width: 96, height: 16 }} />
        <Skeleton style={{ width: "100%", height: 20 }} />
        <Skeleton style={{ width: "90%", height: 20 }} />
        <Skeleton style={{ width: "70%", height: 20 }} />
      </View>
    </View>
  );
}
