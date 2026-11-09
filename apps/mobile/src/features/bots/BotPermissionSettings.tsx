import { useState } from "react";
import { Text, View } from "react-native";
import type { bots } from "@canopy/contracts";
import { BOT_APPROVAL_OPTIONS, BOT_THREAD_PERMISSION_OPTIONS } from "@canopy/domain/bot-chat";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { styles, useColors } from "../../ui/theme";
import { BotApprovalRules } from "./BotApprovalRules";

export function BotPermissionSettings({
  botId,
  selectedRule,
  config,
  onChange,
  disabled,
}: {
  botId?: string;
  selectedRule: string;
  config: bots.BotConfiguration;
  onChange: (config: bots.BotConfiguration) => void;
  disabled: boolean;
}) {
  const c = useColors();
  const [picker, setPicker] = useState("");
  const options = picker === "policy" ? BOT_APPROVAL_OPTIONS : BOT_THREAD_PERMISSION_OPTIONS;

  return (
    <View style={{ gap: 12 }}>
      <Text style={[styles.heading, { color: c.text }]}>Permissions</Text>
      <Text style={[styles.meta, { color: c.muted }]}>
        Protected actions and changes to the bot’s model or permissions always ask first.
      </Text>
      <SelectField
        label="Ask for approval"
        value={
          BOT_APPROVAL_OPTIONS.find((o) => o.value === (config.approvalPolicy || "safe"))?.label ?? "Ask before changes"
        }
        disabled={disabled}
        onPress={() => setPicker("policy")}
      />
      {botId && <BotApprovalRules botId={botId} selectedRule={selectedRule} />}
      <SelectField
        label="Threads started by this bot"
        value={
          BOT_THREAD_PERMISSION_OPTIONS.find((o) => o.value === (config.threadPermission || "same_bot"))?.label ??
          "Use bot permissions"
        }
        disabled={disabled}
        onPress={() => setPicker("thread")}
      />
      <Text style={[styles.meta, { color: c.muted }]}>Thread tool requests also appear in this bot’s chat.</Text>
      <PickerSheet
        title={picker === "policy" ? "Ask for approval" : "Threads started by this bot"}
        visible={!!picker}
        onClose={() => setPicker("")}
        value={picker === "policy" ? config.approvalPolicy || "safe" : config.threadPermission || "same_bot"}
        sections={[{ options }]}
        onSelect={(value) =>
          onChange({ ...config, [picker === "policy" ? "approvalPolicy" : "threadPermission"]: value })
        }
      />
    </View>
  );
}
