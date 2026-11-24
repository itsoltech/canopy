import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "../../ui/Icon";
import { useColors, useTypography, weightedFont } from "../../ui/theme";
import { SettingsMatch } from "./SettingsSearch";

export function EnvironmentRows({ children }: { children: ReactNode }) {
  const c = useColors("settings");

  return <View style={[styles.list, { backgroundColor: c.rule, borderColor: c.ring }]}>{children}</View>;
}

export function EnvironmentRow({
  title,
  description,
  wrapDescription,
  status,
  warning,
  onPress,
  actions,
  checked,
  disabled,
}: {
  title: string;
  description?: string;
  wrapDescription?: boolean;
  status?: string;
  warning?: boolean;
  onPress?: () => void;
  actions?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
}) {
  const c = useColors("settings");
  const type = useTypography();
  const selecting = checked !== undefined;

  const copy = (
    <View style={styles.copy}>
      <Text numberOfLines={1} style={[type.chrome, weightedFont(type.chrome.fontFamily, "medium"), { color: c.text }]}>
        <SettingsMatch text={title} />
      </Text>
      {!!description && (
        <Text numberOfLines={wrapDescription ? undefined : 1} style={[type.meta, { color: c.muted }]}>
          <SettingsMatch text={description} />
        </Text>
      )}
    </View>
  );

  const content = (
    <>
      {copy}
      {!!status && <Text style={[type.meta, styles.status, { color: warning ? c.warning : c.muted }]}>{status}</Text>}
    </>
  );

  const trailing = selecting || (!!onPress && !actions);

  return (
    <View style={[styles.row, { backgroundColor: c.surface }]}>
      {onPress ? (
        <Pressable
          accessibilityRole={selecting ? "checkbox" : "button"}
          accessibilityLabel={[title, description, status].filter(Boolean).join(", ")}
          accessibilityState={{ checked, disabled }}
          disabled={disabled}
          onPress={onPress}
          style={({ pressed }) => [
            styles.body,
            trailing && styles.withSlot,
            { backgroundColor: pressed ? c.pressed : "transparent" },
          ]}
        >
          {content}
          {trailing && (
            <View pointerEvents="none" style={styles.slot}>
              {selecting ? (
                <View
                  style={[
                    styles.checkbox,
                    { borderColor: checked ? c.brand : c.icon, backgroundColor: checked ? c.brand : c.control },
                  ]}
                >
                  {checked && <Icon name="check" size={14} color={c.onControl} />}
                </View>
              ) : (
                <Icon name="chevron-right" color={c.faint} />
              )}
            </View>
          )}
        </Pressable>
      ) : (
        <View style={styles.body}>{content}</View>
      )}
      {!selecting && actions}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { borderWidth: 1, borderRadius: 12, overflow: "hidden", gap: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", paddingRight: 2 },
  body: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 6,
    gap: 6,
  },
  copy: { flex: 1, minWidth: 0, gap: 1 },
  status: { maxWidth: "36%", textAlign: "right" },
  withSlot: { paddingRight: 48 },
  slot: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 1,
    borderRadius: 4,
    justifyContent: "center",
    alignItems: "center",
  },
});
