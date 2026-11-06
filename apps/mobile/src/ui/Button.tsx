import { ActivityIndicator, Pressable, Text, type StyleProp, type ViewStyle } from "react-native";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "./Icon";
import { Skeleton, useSkeleton } from "./Skeleton";
import { useCompactControls, useSettingsDensity } from "./density";
import { font, useColors, useTypography, type Colors } from "./theme";

/** Web: button.ts. One primary per view; everything else secondary or ghost. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** `md`: 40 dp, text 16. `sm`: 32 dp, text 14, for rows, cards and banners. Both reach 48 dp by touch. */
export type ButtonSize = "md" | "sm";

const sizes = {
  md: { height: 40, padding: 12, iconPadding: 10, radius: 8, gap: 6, slop: 4 },
  sm: { height: 32, padding: 10, iconPadding: 8, radius: 6, gap: 4, slop: 8 },
} as const;

function look(variant: ButtonVariant, c: Colors) {
  switch (variant) {
    case "primary":
      return { text: c.onAccent, icon: c.onAccent, background: c.action, pressed: c.actionPressed, ring: false };
    case "ghost":
      return { text: c.soft, icon: c.icon, background: "transparent", pressed: c.pressed, ring: false };
    case "danger":
      return { text: c.danger, icon: c.danger, background: c.control, pressed: c.dangerPressed, ring: true };
    default:
      return { text: c.text, icon: c.icon, background: c.control, pressed: c.controlPressed, ring: true };
  }
}

/** The ring and the light shadow of secondary and danger controls (web: shadow-xs ring-1). */
export function raised(c: Colors): ViewStyle {
  return {
    borderWidth: 1,
    borderColor: c.ring,
    ...(!c.dark && {
      shadowColor: "#000000",
      shadowOpacity: 0.05,
      shadowRadius: 1,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    }),
  };
}

/** Web: Button. `busy` swaps the icon for a spinner and disables the button; the label stays. */
export function Button({
  title,
  onPress,
  variant = "secondary",
  size: explicitSize,
  icon,
  disabled,
  busy,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  /** Default: `md`, `sm` in group headers and banners. */
  size?: ButtonSize;
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const type = useTypography();
  const settings = useSettingsDensity();
  const compact = useCompactControls();
  const size = explicitSize ?? (compact ? "sm" : "md");
  const s = sizes[size];
  const l = look(variant, c);
  const lead = Boolean(icon || busy);

  return (
    <Skeleton>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ disabled: disabled || busy, busy }}
        disabled={disabled || busy}
        onPress={onPress}
        hitSlop={s.slop}
        style={({ pressed }) => [
          {
            minHeight: settings && size === "md" ? 44 : s.height,
            paddingLeft: lead ? s.iconPadding : s.padding,
            paddingRight: s.padding,
            borderRadius: s.radius,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: s.gap,
            opacity: disabled || busy ? 0.5 : 1,
            backgroundColor: pressed ? l.pressed : l.background,
          },
          l.ring && raised(c),
          style,
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={l.icon} style={{ width: 16, height: 16 }} />
        ) : icon ? (
          <Icon name={icon} color={l.icon} />
        ) : null}
        <Text
          numberOfLines={1}
          style={[
            size === "md" ? type.body : type.small,
            { fontFamily: font.medium, color: l.text, flexShrink: 1, textAlign: "center" },
          ]}
        >
          {title}
        </Text>
      </Pressable>
    </Skeleton>
  );
}

/** Web: IconButton. Ghost by default: the icon rests a step lighter and darkens while pressed. */
export function IconButton({
  icon,
  label,
  onPress,
  size = "md",
  variant = "ghost",
  disabled,
  busy,
  style,
  color,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  size?: ButtonSize;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  color?: string;
}) {
  const c = useColors();
  const loading = useSkeleton();
  const s = sizes[size];
  const l = look(variant, c);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy || loading}
      onPress={onPress}
      hitSlop={s.slop}
      style={({ pressed }) => [
        {
          width: s.height,
          height: s.height,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: s.radius,
          backgroundColor: pressed ? l.pressed : l.background,
          opacity: disabled ? 0.5 : 1,
        },
        l.ring && raised(c),
        style,
      ]}
    >
      {({ pressed }) =>
        busy ? (
          <ActivityIndicator size="small" color={l.icon} />
        ) : (
          <Icon name={icon} color={color ?? (pressed && variant === "ghost" ? c.iconStrong : l.icon)} />
        )
      }
    </Pressable>
  );
}
