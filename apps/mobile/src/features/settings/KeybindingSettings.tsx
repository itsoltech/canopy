import { Text, View } from "react-native";
import { bindingEnabled, bindingCatalogue, type BindingGroup } from "@canopy/ui/keybindings";
import { useAppearance } from "../../state/appearance";
import { SearchField } from "../../ui/SearchField";
import { useTypography, useColors } from "../../ui/theme";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";

import { createSettingsViewState } from "./SettingsScroll";

const useKeybindingSearch = createSettingsViewState("");

export function KeybindingSettings() {
  const [query, setQuery] = useKeybindingSearch();
  const c = useColors();
  const type = useTypography();
  const { modules } = useAppearance();
  const groups: BindingGroup[] = ["Navigation", "Threads", "Composer", "Messages", "Models", "Appearance", "Settings"];

  const filtered = bindingCatalogue.filter(
    (d) =>
      bindingEnabled(d, modules) &&
      `${d.title} ${d.group} ${d.when} ${d.defaults.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <View style={{ gap: 24 }}>
      <Text style={[type.meta, { color: c.muted }]}>
        Default keyboard shortcuts for web and desktop. Customize them in the browser or desktop app where you use them.
      </Text>
      <SearchField label="Search keybindings" value={query} onChange={setQuery} placeholder="Toggle sidebar, Mod+B" />
      {groups.map((group) => {
        const entries = filtered.filter((d) => d.group === group);

        return entries.length ? (
          <SettingsGroup key={group} title={group}>
            {entries.map((command) => (
              <SettingsRow
                key={command.id}
                title={command.title}
                description={`When: ${command.when}.`}
                control={
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                    {command.defaults.length ? (
                      command.defaults.map((shortcut) => (
                        <Text
                          key={shortcut}
                          style={[
                            type.meta,
                            {
                              color: c.text,
                              backgroundColor: c.inset,
                              borderColor: c.ring,
                              borderWidth: 1,
                              borderRadius: 4,
                              paddingHorizontal: 6,
                              paddingVertical: 3,
                              fontFamily: type.mono.fontFamily,
                            },
                          ]}
                        >
                          {shortcut}
                        </Text>
                      ))
                    ) : (
                      <Text style={[type.meta, { color: c.muted }]}>Unassigned</Text>
                    )}
                  </View>
                }
              />
            ))}
          </SettingsGroup>
        ) : null;
      })}
      {!filtered.length && (
        <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.muted, textAlign: "center" }]}>
          No commands match “{query}”.
        </Text>
      )}
    </View>
  );
}
