import { useContext } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "./Icon";
import { Skeleton, useSkeleton } from "./Skeleton";
import { SettingsButtonAlignment, useCompactControls, useSettingsDensity } from "./density";
import { font, useColors, useTypography, weightedFont, type Colors } from "./theme";

/** Web: button.ts. One primary per view; everything else secondary or ghost. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "text" | "danger";

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
    case "text":
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
  label,
  hint,
  multiline = false,
  reserveTouchTarget = false,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  /** Settings actions, group headers and banners default to `sm`. Sheet footers default to `md`. */
  size?: ButtonSize;
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  label?: string;
  hint?: string;
  multiline?: boolean;
  /** Reserve a 48 dp pressable area around the visible button in the layout. */
  reserveTouchTarget?: boolean;
}) {
  const c = useColors();
  const type = useTypography();
  const settings = useSettingsDensity();
  const compact = useCompactControls();
  const alignment = useContext(SettingsButtonAlignment);
  const size = explicitSize ?? (compact || (settings && alignment !== "stretch") ? "sm" : "md");
  const s = sizes[size];
  const l = look(variant, c);
  const lead = Boolean(icon || busy);
  const touchSize = reserveTouchTarget || (settings && size === "sm") ? 48 : undefined;
  const alignSelf = StyleSheet.flatten(style)?.alignSelf;
  const labelType = size === "md" ? type.body : type.small;

  return (
    <Skeleton style={settings ? { maxWidth: "100%", alignSelf: alignSelf ?? alignment } : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label ?? title}
        accessibilityHint={hint}
        accessibilityState={{ disabled: disabled || busy, busy }}
        disabled={disabled || busy}
        onPress={onPress}
        hitSlop={settings ? 2 : s.slop}
        style={{
          alignSelf: alignSelf ?? (variant === "text" ? "flex-start" : undefined),
          justifyContent: "center",
          minHeight: touchSize,
          minWidth: touchSize,
        }}
      >
        {({ pressed }) => (
          <View
            style={[
              {
                minHeight: settings && size === "md" ? 44 : s.height,
                minWidth: settings ? 44 : undefined,
                paddingLeft: variant === "text" ? 0 : lead ? s.iconPadding : s.padding,
                paddingRight: variant === "text" ? 0 : s.padding,
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
              numberOfLines={multiline || settings ? undefined : 1}
              style={[
                labelType,
                settings ? weightedFont(labelType.fontFamily, "medium") : { fontFamily: font.medium },
                { color: l.text, flexShrink: 1, textAlign: "center" },
              ]}
            >
              {title}
            </Text>
          </View>
        )}
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
  const settings = useSettingsDensity();
  const s = sizes[size];
  const l = look(variant, c);

  const compactKey = settings && size === "sm" && l.ring;
  const target = settings ? (compactKey ? 48 : 44) : s.height;

  const face = (pressed: boolean) => [
    { borderRadius: s.radius, backgroundColor: pressed ? l.pressed : l.background },
    l.ring && raised(c),
  ];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy || loading, busy }}
      disabled={disabled || busy || loading}
      onPress={onPress}
      hitSlop={settings ? 2 : s.slop}
      style={({ pressed }) => [
        {
          width: target,
          height: target,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.5 : 1,
        },
        !compactKey && face(pressed),
        style,
      ]}
    >
      {({ pressed }) => {
        const content = busy ? (
          <ActivityIndicator size="small" color={l.icon} />
        ) : (
          <Icon name={icon} color={color ?? (pressed && variant === "ghost" ? c.iconStrong : l.icon)} />
        );

        return compactKey ? (
          <View
            style={[
              { width: s.height, height: s.height, alignItems: "center", justifyContent: "center" },
              face(pressed),
            ]}
          >
            {content}
          </View>
        ) : (
          content
        );
      }}
    </Pressable>
  );
}
