import { useState } from "react";
import { Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { BOT_APPROVAL_OPTIONS, BOT_THREAD_PERMISSION_OPTIONS } from "@canopy/domain/bot-chat";
import { useSession } from "../../state/session";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { styles, useColors } from "../../ui/theme";
import { BotApprovalRules } from "./BotApprovalRules";
import { BotModelSettings } from "./BotModelSettings";
import { BotAppearanceSettings } from "./BotAppearanceSettings";
import { BotSettingsExtras } from "./BotSettingsExtras";

export function BotSettings({
  bot,
  selectedRule = "",
  onClose,
}: {
  bot: bots.Bot;
  selectedRule?: string;
  onClose: () => void;
}) {
  const { client } = useSession();
  const c = useColors();
  const [config, setConfig] = useState(() => create(bots.BotConfigurationSchema, bot.configuration));
  const [picker, setPicker] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options = picker === "policy" ? BOT_APPROVAL_OPTIONS : BOT_THREAD_PERMISSION_OPTIONS;

  async function save() {
    setBusy(true);
    setError("");

    try {
      await client!.api.updateBot({ botId: bot.id, configuration: config });
      onClose();
    } catch {
      setError("Could not save bot settings. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Bot settings"
      visible
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <Field
        label="Name"
        value={config.name}
        editable={!busy}
        onChangeText={(name) => setConfig({ ...config, name })}
        maxLength={80}
      />
      <Field
        label="Standing instructions"
        value={config.instructions}
        editable={!busy}
        onChangeText={(instructions) => setConfig({ ...config, instructions })}
        multiline
        maxLength={32000}
      />
      <BotAppearanceSettings config={config} onChange={setConfig} disabled={busy} />
      <BotModelSettings bot={bot} config={config} onChange={setConfig} disabled={busy} />
      <View style={{ gap: 12 }}>
        <Text style={[styles.heading, { color: c.text }]}>Permissions</Text>
        <Text style={[styles.meta, { color: c.muted }]}>
          Protected actions and changes to the bot’s model or permissions always ask first.
        </Text>
        <SelectField
          label="Ask for approval"
          value={BOT_APPROVAL_OPTIONS.find((o) => o.value === (config.approvalPolicy || "safe"))!.label}
          disabled={busy}
          onPress={() => setPicker("policy")}
        />
        <BotApprovalRules botId={bot.id} selectedRule={selectedRule} />
        <SelectField
          label="Threads started by this bot"
          value={BOT_THREAD_PERMISSION_OPTIONS.find((o) => o.value === (config.threadPermission || "same_bot"))!.label}
          disabled={busy}
          onPress={() => setPicker("thread")}
        />
        <Text style={[styles.meta, { color: c.muted }]}>Thread tool requests also appear in this bot’s chat.</Text>
      </View>
      {error ? <Notice error>{error}</Notice> : null}
      <Button title="Save changes" busy={busy} onPress={() => void save()} />
      <BotSettingsExtras bot={bot} onClose={onClose} disabled={busy} />
      <PickerSheet
        title={picker === "policy" ? "Ask for approval" : "Threads started by this bot"}
        visible={!!picker}
        onClose={() => setPicker("")}
        value={picker === "policy" ? config.approvalPolicy || "safe" : config.threadPermission || "same_bot"}
        sections={[{ options }]}
        onSelect={(value) =>
          setConfig({ ...config, [picker === "policy" ? "approvalPolicy" : "threadPermission"]: value })
        }
      />
    </Sheet>
  );
}
