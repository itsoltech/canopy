import { View } from "react-native";
import type { bots } from "@canopy/contracts";
import { Field, Notice } from "../../ui/components";
import { BotAppearanceSettings } from "./BotAppearanceSettings";
import { BotFormSection } from "./BotFormSection";
import { BotModelSettings } from "./BotModelSettings";
import { BotPermissionSettings } from "./BotPermissionSettings";
import { MascotAvatar } from "./BotAvatar";

export function BotSettingsFields({
  bot,
  config,
  onChange,
  creating,
  selectedRule,
  disabled,
  modelDisabled,
  nameIssue,
  draftError,
}: {
  bot: bots.Bot;
  config: bots.BotConfiguration;
  onChange: (config: bots.BotConfiguration) => void;
  creating: boolean;
  selectedRule: string;
  disabled: boolean;
  modelDisabled: boolean;
  nameIssue?: string;
  draftError?: string;
}) {
  const name = (
    <Field
      label="Name"
      value={config.name}
      editable={!disabled}
      onChangeText={(name) => onChange({ ...config, name })}
      maxLength={80}
    />
  );

  const instructions = (
    <Field
      label={creating ? "Standing instructions (optional)" : "Standing instructions"}
      value={config.instructions}
      editable={!disabled}
      onChangeText={(instructions) => onChange({ ...config, instructions })}
      multiline
      maxLength={32000}
      placeholder={creating ? "What should this bot do?" : undefined}
      returnKeyType={creating ? "default" : "done"}
      style={creating ? { minHeight: 96, maxHeight: 176, textAlignVertical: "top" } : undefined}
    />
  );

  const appearance = (
    <BotAppearanceSettings config={config} onChange={onChange} disabled={disabled} creating={creating} />
  );

  const permissions = (
    <BotPermissionSettings
      botId={creating ? undefined : bot.id}
      selectedRule={selectedRule}
      config={config}
      onChange={onChange}
      disabled={disabled}
      showHeading={!creating}
    />
  );

  if (creating)
    return (
      <>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12 }}>
            <View accessible={false} importantForAccessibility="no-hide-descendants">
              <MascotAvatar id="preview" shape={config.shape} color={config.color} size={44} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>{name}</View>
          </View>
          {config.name.trim() && nameIssue ? <Notice error>{nameIssue}</Notice> : null}
        </View>
        <BotModelSettings
          bot={bot}
          config={config}
          onChange={onChange}
          disabled={modelDisabled}
          renderFields={({ model, runtime }) => (
            <>
              {model}
              {instructions}
              <View>
                <BotFormSection title="Worker and model options" disabled={modelDisabled}>
                  {runtime}
                </BotFormSection>
                <BotFormSection title="Appearance" disabled={disabled}>
                  {appearance}
                </BotFormSection>
                <BotFormSection title="Permissions" disabled={disabled}>
                  {permissions}
                </BotFormSection>
              </View>
            </>
          )}
        />
      </>
    );

  return (
    <>
      {name}
      {instructions}
      {appearance}
      <BotModelSettings bot={bot} config={config} onChange={onChange} disabled={modelDisabled} />
      {config.name.trim() && draftError ? <Notice error>{draftError}</Notice> : null}
      {permissions}
    </>
  );
}
