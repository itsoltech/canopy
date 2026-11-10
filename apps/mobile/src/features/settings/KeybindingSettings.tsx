import { useState } from "react";
import { Text, View } from "react-native";
import { bindingCatalogue, type BindingGroup } from "@canopy/ui/keybindings";
import { Field, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";

export function KeybindingSettings() {
  const [query, setQuery] = useState("");
  const c = useColors();
  const groups: BindingGroup[] = ["Navigation", "Threads", "Composer", "Messages", "Models", "Appearance", "Settings"];

  const filtered = bindingCatalogue.filter((d) =>
    `${d.title} ${d.group} ${d.when} ${d.defaults.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <View style={{ gap: 24 }}>
      <Notice>Reference for web and desktop hardware keyboards. Shortcuts apply to that browser or desktop app.</Notice>
      <Field
        label="Search keybindings"
        value={query}
        onChangeText={setQuery}
        placeholder="Toggle sidebar, Mod+B"
        autoCapitalize="none"
      />
      {groups.map((group) => {
        const entries = filtered.filter((d) => d.group === group);

        return entries.length ? (
          <SettingsGroup key={group} title={group}>
            {entries.map((command) => (
              <SettingsRow key={command.id} title={command.title} description={`When: ${command.when}.`}>
                <Text style={[styles.caption, { color: c.muted, fontFamily: "monospace" }]}>
                  {command.defaults.join(" · ") || "Unassigned"}
                </Text>
              </SettingsRow>
            ))}
          </SettingsGroup>
        ) : null;
      })}
      {!filtered.length && <Notice>No commands match “{query}”.</Notice>}
    </View>
  );
}
