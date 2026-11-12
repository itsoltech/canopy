import { useState } from "react";
import { Pressable, Text } from "react-native";
import type { github } from "@canopy/contracts";
import { PickerSheet } from "../../ui/Picker";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

export function PullRequestPickerAccount({
  selection,
  disabled,
  onchoose,
}: {
  selection: github.GitHubRepositoryAccountResponse;
  disabled: boolean;
  onchoose: (accountId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const c = useColors();
  const current = selection.candidates.find((a) => a.id === selection.accountId);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`GitHub account: ${current?.login ?? "Choose an account"}`}
        accessibilityState={{ disabled }}
        onPress={() => setOpen(true)}
        disabled={disabled}
        hitSlop={6}
        style={({ pressed }) => ({
          minWidth: 0,
          maxWidth: 96,
          minHeight: 32,
          flexShrink: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          borderRadius: 4,
          backgroundColor: pressed ? c.pressed : "transparent",
          opacity: disabled ? 0.5 : 1,
        })}
      >
        <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.accent, flexShrink: 1 }]}>
          {current?.login ?? "Choose an account"}
        </Text>
        <Icon name="chevron-up-down" size={14} />
      </Pressable>
      <PickerSheet
        title="Choose an account"
        visible={open}
        onClose={() => setOpen(false)}
        value={selection.accountId}
        sections={[{ options: selection.candidates.map((a) => ({ value: a.id, label: a.login })) }]}
        onSelect={(id) => {
          setOpen(false);

          if (id !== selection.accountId) onchoose(id);
        }}
      />
    </>
  );
}
