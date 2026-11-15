import { useState } from "react";
import { Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { useAppearance } from "../../state/appearance";
import { Button } from "../../ui/components";
import { TextInput } from "../../ui/TextInput";
import { Switch } from "../../ui/Switch";
import { styles, useColors, useTypography } from "../../ui/theme";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ResetSetting } from "./ResetSetting";

export function ThreadRetentionSettings({ settings }: { settings: ReturnType<typeof useAppearance> }) {
  const c = useColors();
  const type = useTypography();
  const [draft, setDraft] = useState<{ enabled: boolean; days: string }>();
  const [pending, setPending] = useState(false);
  const saved = settings.user?.threadRetention?.archivedThreadDays ?? 0;
  const value = draft ?? { enabled: saved > 0, days: String(saved || 14) };
  const parsed = Number(value.days);
  const validDays = /^\d+$/.test(value.days) && Number.isInteger(parsed) && parsed >= 1 && parsed <= 36500;
  const valid = !value.enabled || validDays;
  const days = value.enabled ? parsed : 0;
  const disabled = !settings.user || settings.saving || pending;

  async function save() {
    if (disabled || !valid || days === saved) return;
    setPending(true);

    try {
      const saved = await settings.update({
        threadRetention: create(ui.ThreadRetentionSettingsSchema, { archivedThreadDays: days }),
      });

      if (saved) setDraft(undefined);
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsGroup
      title="Archived threads"
      description="Permanently deletes threads and their history after this many days in the archive."
    >
      <SettingsRow
        title="Auto-delete archived threads"
        description="Applies to existing archived threads."
        inlineControl
        accessory={
          <ResetSetting
            label="Reset auto-delete archived threads to default"
            changed={value.enabled}
            disabled={disabled}
            onReset={() => setDraft({ enabled: false, days: "14" })}
          />
        }
        control={
          <View style={{ minHeight: 44, justifyContent: "center" }}>
            <Switch
              label="Auto-delete archived threads"
              value={value.enabled}
              disabled={disabled}
              onChange={(enabled) => setDraft({ enabled, days: validDays ? value.days : "14" })}
            />
          </View>
        }
      />
      <SettingsRow
        title="Delete after"
        control={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <TextInput
              accessibilityLabel="Days in archive"
              accessibilityHint="Enter a whole number from 1 to 36500 days, then save."
              keyboardType="number-pad"
              value={value.days}
              onChangeText={(days) => setDraft({ ...value, days })}
              editable={!disabled && value.enabled}
              autoCorrect={false}
              style={[
                styles.input,
                type.body,
                {
                  flex: 1,
                  minWidth: 80,
                  color: c.text,
                  borderColor: c.line,
                  backgroundColor: c.surface,
                  opacity: value.enabled ? 1 : 0.5,
                },
              ]}
            />
            <Text style={[type.meta, { color: c.muted }]}>days</Text>
          </View>
        }
      >
        <Text style={[type.meta, { color: c.muted }]}>Workspace files stay unchanged.</Text>
        <Text style={[type.meta, { color: c.muted }]}>Deletion waits while forks still need a thread’s history.</Text>
        <Text accessibilityLiveRegion="polite" style={[type.meta, { minHeight: 20, color: c.danger }]}>
          {!valid ? "Enter a whole number from 1 to 36500 days, then save." : ""}
        </Text>
        <View style={{ alignItems: "flex-end" }}>
          <Button
            title="Save"
            busy={pending}
            disabled={disabled || !valid || days === saved}
            onPress={() => void save()}
          />
        </View>
      </SettingsRow>
    </SettingsGroup>
  );
}
