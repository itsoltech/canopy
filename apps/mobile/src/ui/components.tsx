import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Keyboard,
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
import { styles, useColors } from "./theme";
import type { Connection } from "../state/stream";
import { Icon } from "./Icon";
import type { IconName } from "@canopy/ui/icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";

export function Button({
  title,
  onPress,
  disabled,
  busy,
  secondary,
  danger,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  secondary?: boolean;
  danger?: boolean;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: secondary || danger ? 1 : 0,
        borderColor: c.line,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        opacity: disabled || busy ? 0.45 : pressed ? 0.75 : 1,
        backgroundColor: secondary || danger ? c.inset : c.action,
      })}
    >
      {busy && <ActivityIndicator color={secondary ? c.text : c.onAccent} />}
      <Text style={[styles.label, { color: danger ? c.danger : secondary ? c.text : c.onAccent }]}>{title}</Text>
    </Pressable>
  );
}

export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  style,
  color,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  color?: string;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        {
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 8,
          backgroundColor: pressed ? c.inset : "transparent",
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      <Icon name={icon} color={color} />
    </Pressable>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  back = true,
  left,
  right,
}: {
  title: string;
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
        <Text numberOfLines={1} style={[styles.label, { color: c.text }]}>
          {title}
        </Text>
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
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();

  return (
    <View style={[styles.row, { backgroundColor: c.inset, padding: 2, gap: 2, borderRadius: 8 }, style]}>
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === option.value }}
          onPress={() => onChange(option.value)}
          style={{
            flex: 1,
            minHeight: 36,
            paddingHorizontal: 12,
            paddingVertical: 6,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            backgroundColor: value === option.value ? c.surface : "transparent",
            borderWidth: value === option.value ? 1 : 0,
            borderColor: c.line,
          }}
        >
          <Text style={[styles.meta, { color: value === option.value ? c.text : c.muted }]}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

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
        <ScreenHeader
          title={title}
          back={false}
          right={<IconButton icon="x-mark" label={`Close ${title}`} onPress={onClose} />}
        />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const c = useColors();

  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.label, { color: c.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={c.muted}
        returnKeyType="done"
        onSubmitEditing={Keyboard.dismiss}
        {...props}
        style={[styles.input, { color: c.text, borderColor: c.line, backgroundColor: c.surface }, props.style]}
      />
    </View>
  );
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  const c = useColors();

  return (
    <View
      accessibilityRole={error ? "alert" : "text"}
      accessibilityLiveRegion="polite"
      style={{ padding: 16, borderRadius: 12, backgroundColor: c.inset }}
    >
      <Text style={[styles.body, { color: error ? c.danger : c.muted }]}>{children}</Text>
    </View>
  );
}

export function ConnectionNotice({
  connection,
  retry,
  issue,
}: {
  connection: Connection;
  retry: () => void;
  issue?: string;
}) {
  if (connection === "live") return null;

  return (
    <View style={{ gap: 10 }}>
      <Notice error={connection === "error"}>
        {issue ||
          (connection === "offline"
            ? "You’re offline. Your conversation will reconnect when the network returns."
            : connection === "paused"
              ? "Updates paused while Canopy is in the background."
              : connection === "reconnecting"
                ? "Connection lost. Reconnecting automatically…"
                : "Connecting to your Canopy…")}
      </Notice>
      {["reconnecting", "error"].includes(connection) && <Button title="Reconnect now" secondary onPress={retry} />}
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
