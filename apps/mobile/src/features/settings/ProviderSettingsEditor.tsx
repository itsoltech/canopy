import { Text, View } from "react-native";
import { Provider } from "@canopy/contracts";
import { providerSettingsEditor } from "@canopy/domain/provider-settings-editor";
import { Button, Field } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { SettingsActions, SettingsGroup, SettingsSection } from "./SettingsGroup";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { ProviderSettingsCode } from "./ProviderSettingsCode";

export function ProviderSettingsEditor({
  harness,
  value,
  onChange,
  busy,
  problem,
  worker,
}: {
  harness: Provider;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  problem: string | undefined;
  worker?: { name: string; inherited: string | undefined };
}) {
  const c = useColors();
  const type = useTypography();

  const editor = providerSettingsEditor(Provider[harness]?.toLowerCase() ?? "");

  if (!editor) return null;
  const Section = worker ? SettingsSection : SettingsGroup;

  return (
    <Section
      title={worker ? `CLI settings on ${worker.name}` : "CLI settings for all workers"}
      description={
        worker ? "Keys entered here override settings from All workers." : "Applies to workers that use this instance."
      }
    >
      <View style={{ gap: 6 }}>
        <Field
          label={editor.filename}
          value={value}
          onChangeText={onChange}
          accessibilityHint={problem}
          placeholder={worker ? undefined : editor.example}
          editable={!busy}
          multiline
          submitBehavior="newline"
          returnKeyType="default"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          spellCheck={false}
          smartInsertDelete={false}
          style={[type.mono, { minHeight: 112, maxHeight: 240, textAlignVertical: "top" }]}
        />
        {!!problem && (
          <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.danger }]}>
            {problem}
          </Text>
        )}
        {!worker && <Text style={[type.meta, { color: c.muted }]}>Use Environment to store secrets.</Text>}
      </View>
      {worker && (
        <SettingsActions>
          <Button
            title="Use inherited settings"
            variant="ghost"
            disabled={busy || !value}
            onPress={() => onChange("")}
          />
        </SettingsActions>
      )}
      <SettingsDisclosure title="Preview syntax">
        {value ? (
          <ProviderSettingsCode value={value} format={editor.format} />
        ) : (
          <Text style={[type.meta, { color: c.muted }]}>Enter CLI settings to preview them.</Text>
        )}
      </SettingsDisclosure>
      {!!worker?.inherited?.trim() && (
        <SettingsDisclosure title="View shared settings">
          <ProviderSettingsCode value={worker.inherited} format={editor.format} />
        </SettingsDisclosure>
      )}
      <SettingsDisclosure title="View supported keys">
        <Text selectable style={[type.mono, { color: c.muted }]}>
          {editor.keys.join("\n")}
        </Text>
      </SettingsDisclosure>
    </Section>
  );
}
