import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "../../../ui/Icon";
import { useTween } from "../../../ui/motion";
import { useColors } from "../../../ui/theme";

/** Rows of the tray have 40 dp; the hit slop takes their targets to 48 dp. */
export const TRAY_ROW = 40;

/**
 * One header rhythm for the tray's panels (web: ComposerPanelHeader): what the panel sums up, anything trailing
 * it, and how a tap continues: a chevron that turns with an accordion, or one that points into a sheet.
 */
export function TrayHeader({
  label,
  onPress,
  expanded,
  opens = "panel",
  disabled = false,
  children,
  trailing,
}: {
  label: string;
  onPress: () => void;
  /** An accordion's state; sheets have none. */
  expanded?: boolean;
  /** `panel` unfolds in place; `sheet` opens a sheet. */
  opens?: "panel" | "sheet";
  disabled?: boolean;
  children: ReactNode;
  /** Actions beside the header (outside its button). */
  trailing?: ReactNode;
}) {
  const c = useColors();

  return (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: TRAY_ROW, paddingRight: trailing ? 4 : 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded, disabled }}
        disabled={disabled}
        hitSlop={{ top: 4, bottom: 4 }}
        onPress={onPress}
        style={({ pressed }) => ({
          flex: 1,
          minWidth: 0,
          minHeight: TRAY_ROW,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingLeft: 12,
          paddingRight: trailing ? 4 : 12,
          opacity: disabled ? 0.5 : 1,
          backgroundColor: pressed ? c.pressed : undefined,
        })}
      >
        {children}
        {opens === "sheet" ? (
          <Icon name="chevron-right" size={12} color={c.faint} />
        ) : (
          <TrayChevron open={Boolean(expanded)} />
        )}
      </Pressable>
      {trailing}
    </View>
  );
}

/** The accordion's chevron (web `t-acc-chevron`): down when folded, up when open. */
function TrayChevron({ open }: { open: boolean }) {
  const c = useColors();
  const turn = useTween(open ? 180 : 0);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get()}deg` }] }));

  return (
    <Animated.View style={style}>
      <Icon name="chevron-down" size={12} color={c.faint} />
    </Animated.View>
  );
}

/** A panel's leading icon: 16 dp in the header's text colour or a tone. */
export function TrayIcon({ name, color }: { name: IconName; color?: string }) {
  const c = useColors();

  return <Icon name={name} size={16} color={color ?? c.icon} />;
}
