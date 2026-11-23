import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Chevron, Expand } from "../../ui/MotionViews";
import { useReducedMotion } from "../../ui/motion";
import { Skeleton, useSkeleton } from "../../ui/Skeleton";
import { useMinimumTouchTarget } from "../../ui/density";
import { styles, useColors, useTypography } from "../../ui/theme";
import { SettingsMatch } from "./SettingsSearch";

import { createSettingsViewState } from "./SettingsScroll";

const useDisclosureOpen = createSettingsViewState(false);

export function SettingsDisclosure({
  title,
  children,
  initiallyOpen = false,
  open: controlledOpen,
  onOpenChange,
  viewKey,
}: {
  title: string;
  children: ReactNode;
  initiallyOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  viewKey?: string;
}) {
  const [localOpen, setLocalOpen] = useDisclosureOpen(viewKey ?? null, initiallyOpen);
  const open = controlledOpen ?? localOpen;
  const c = useColors();
  const type = useTypography();
  const loading = useSkeleton();
  const target = useMinimumTouchTarget();
  const reduced = useReducedMotion();

  const panel = (
    <View
      pointerEvents={open ? "auto" : "none"}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      style={{ gap: 8, paddingTop: 8 }}
    >
      {children}
    </View>
  );

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open, disabled: loading }}
        disabled={loading}
        onPress={() => {
          if (controlledOpen === undefined) setLocalOpen(!open);
          onOpenChange?.(!open);
        }}
        style={({ pressed }) => [
          styles.row,
          { minHeight: target, borderRadius: 6, backgroundColor: pressed ? c.pressed : "transparent" },
        ]}
      >
        <Chevron open={open} color={c.faint} />
        <Skeleton style={{ flexShrink: 1 }}>
          <Text style={[type.chrome, { color: c.text }]}>
            <SettingsMatch text={title} />
          </Text>
        </Skeleton>
      </Pressable>
      {reduced ? open && panel : <Expand open={open}>{panel}</Expand>}
    </View>
  );
}
