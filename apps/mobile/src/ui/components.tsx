import { createContext, useState, type ReactNode } from "react";
import {
  Keyboard,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { font, styles, useColors, useTypography } from "./theme";
import { Icon } from "./Icon";
import { IconButton } from "./Button";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Skeleton } from "./Skeleton";
import { useSettingsDensity } from "./density";

export const SheetContent = createContext(false);

export { Button, IconButton } from "./Button";

export { Alert, EmptyState, Notice } from "./Alert";

export function ScreenHeader({
  title,
  loading = false,
  subtitle,
  back = true,
  left,
  right,
}: {
  title: string;
  loading?: boolean;
  subtitle?: string;
  back?: boolean;
  /** Replaces the back button (the sidebar toggle on wide windows). */
  left?: ReactNode;
  right?: ReactNode;
}) {
  const c = useColors();

  return (
    <View
      style={[
        styles.row,
        {
          minHeight: 48,
          paddingHorizontal: 8,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
        },
      ]}
    >
      {left}
      {back && !left && (
        <IconButton
          icon="chevron-left"
          label="Back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
      )}
      <View style={{ flex: 1, paddingHorizontal: back ? 0 : 8 }}>
        {subtitle && (
          <Text numberOfLines={1} style={[styles.caption, { color: c.muted }]}>
            {subtitle} /
          </Text>
        )}
        {loading ? (
          <Skeleton style={{ width: "60%", height: 20 }} />
        ) : (
          <Text numberOfLines={1} style={[styles.label, { color: c.text }]}>
            {title}
          </Text>
        )}
      </View>
      {right}
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  /** `badge`: a count beside the label of a segment that is not selected (unread items there). */
  options: readonly { value: T; label: string; badge?: number }[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={[styles.row, { backgroundColor: c.recess, padding: 2, gap: 2, borderRadius: 8 }, style]}>
      {options.map((option) => {
        const active = value === option.value;

        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            hitSlop={{ top: 6, bottom: 6 }}
            style={{
              flex: 1,
              minHeight: 32,
              paddingHorizontal: 12,
              paddingVertical: 6,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
              backgroundColor: active ? (c.dark ? "#ffffff1a" : "#ffffff") : "transparent",
              ...(active &&
                !c.dark && {
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: c.ring,
                  shadowColor: "#000000",
                  shadowOpacity: 0.05,
                  shadowRadius: 1,
                  shadowOffset: { width: 0, height: 1 },
                  elevation: 1,
                }),
            }}
          >
            {/* The badge sits beside the label, outside its flow: the label stays put when it appears. */}
            <View>
              <Text style={[type.small, { fontFamily: font.medium, color: active ? c.text : c.muted }]}>
                {option.label}
              </Text>
              {!active && !!option.badge && (
                <View
                  accessibilityLabel={`${option.badge} unread`}
                  style={{
                    position: "absolute",
                    left: "100%",
                    top: 0,
                    bottom: 0,
                    marginLeft: 6,
                    justifyContent: "center",
                  }}
                >
                  <Text
                    style={[
                      styles.caption,
                      {
                        color: c.onAccent,
                        backgroundColor: c.accent,
                        borderRadius: 999,
                        overflow: "hidden",
                        paddingHorizontal: 6,
                        fontVariant: ["tabular-nums"],
                      },
                    ]}
                  >
                    {option.badge > 99 ? "99+" : option.badge}
                  </Text>
                </View>
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A full-height sheet (web: Dialog): a semibold title, a small close button, the content below. */
export function Sheet({
  title,
  visible,
  onClose,
  children,
}: {
  title: string;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const c = useColors();

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={[styles.fill, { backgroundColor: c.surface }]}>
        <View style={[styles.row, { paddingLeft: 20, paddingRight: 12, paddingTop: 16, paddingBottom: 4 }]}>
          <Text accessibilityRole="header" numberOfLines={2} style={[styles.heading, { flex: 1, color: c.text }]}>
            {title}
          </Text>
          <IconButton icon="x-mark" size="sm" label={`Close ${title}`} onPress={onClose} />
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.page, { maxWidth: 600, paddingHorizontal: 20 }]}
        >
          <SheetContent.Provider value={true}>{children}</SheetContent.Provider>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/** A labelled text field (web: Field + Input): 40 dp, a 1 dp divider outline that turns accent and 2 dp on focus. */
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const c = useColors();
  const type = useTypography();
  const [focused, setFocused] = useState(false);
  const settings = useSettingsDensity();
  const disabled = props.editable === false;

  return (
    <View style={{ gap: 6 }}>
      <Text style={[type.body, { fontFamily: font.medium, color: c.text }]}>{label}</Text>
      <Skeleton>
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={c.muted}
          returnKeyType="done"
          onSubmitEditing={Keyboard.dismiss}
          {...props}
          onFocus={(event) => {
            setFocused(true);
            props.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            props.onBlur?.(event);
          }}
          style={[
            styles.input,
            type.body,
            {
              color: disabled ? c.muted : c.text,
              backgroundColor: disabled ? c.sidebar : c.surface,
              borderColor: focused ? c.accent : c.line,
            },
            settings && { minHeight: 44 },
            // The 2 dp focus outline takes its extra width from the padding, so the text does not move.
            focused && { borderWidth: 2, paddingHorizontal: 11, paddingVertical: 7 },
            props.style,
          ]}
        />
      </Skeleton>
    </View>
  );
}

/** Floats over the feed's bottom edge, so it appears without moving the feed or the composer. */
export function LatestButton({ visible, onPress }: { visible: boolean; onPress: () => void }) {
  const c = useColors();

  if (!visible) return null;

  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, top: -56, alignItems: "center" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show latest messages"
        onPress={onPress}
        hitSlop={4}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? c.inset : c.surface,
          borderWidth: 1,
          borderColor: c.line,
          shadowColor: "#000000",
          shadowOpacity: c.dark ? 0.4 : 0.12,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
          elevation: 3,
        })}
      >
        <Icon name="arrow-down" color={c.text} />
      </Pressable>
    </View>
  );
}
