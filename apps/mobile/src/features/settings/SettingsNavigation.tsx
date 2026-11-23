import { matchesSettingsSection, settingsGroups } from "@canopy/ui/settings";
import { Pressable, Text, View } from "react-native";
import { useOverview } from "../../state/overview";
import { StatusDot } from "../../ui/Badge";
import { Button, Notice } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { SearchField } from "../../ui/SearchField";
import { styles, useColors, useTypography } from "../../ui/theme";
import { CANOPY_VERSION } from "../../version";
import { useSectionAvailability } from "./section-catalog";
import { SettingsScroll } from "./SettingsScroll";

export function useWorkerUpdateHint() {
  return useOverview().workers.some((worker) => worker.cliTools.some((tool) => tool.action === "update"));
}

export function SettingsNavigation({
  section,
  onSelect,
  query,
  onQuery,
  compact,
  updates,
}: {
  section: string;
  onSelect: (section: string) => void;
  query: string;
  onQuery: (query: string) => void;
  compact: boolean;
  updates: boolean;
}) {
  const c = useColors();
  const type = useTypography();
  const catalog = useSectionAvailability();
  const shown = catalog.available.filter((entry) => matchesSettingsSection(entry, query));

  return (
    <SettingsScroll
      position="navigation"
      space={12}
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1 }}
      contentContainerStyle={{ maxWidth: undefined, gap: 12 }}
    >
      <SearchField label="Search settings" placeholder="Search" value={query} onChange={onQuery} />
      {settingsGroups.map((group) => {
        const entries = shown.filter((entry) => entry.group === group);

        if (!entries.length) return null;

        return (
          <View key={group} style={{ gap: 2 }}>
            <Text
              accessibilityRole="header"
              style={[type.meta, { paddingHorizontal: 10, paddingVertical: 4, color: c.muted }]}
            >
              {group}
            </Text>
            {entries.map((entry) => {
              const slug = entry.href.slice("/settings/".length);
              const active = section === slug;
              const hinted = slug === "workers" && updates;

              return (
                <Pressable
                  key={entry.href}
                  accessibilityRole="button"
                  accessibilityLabel={entry.label}
                  accessibilityValue={hinted ? { text: "Updates available" } : undefined}
                  accessibilityState={{ selected: active }}
                  onPress={() => onSelect(slug)}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      minHeight: 44,
                      paddingHorizontal: 10,
                      borderRadius: 8,
                      backgroundColor: pressed || (active && !compact) ? c.inset : "transparent",
                    },
                  ]}
                >
                  <Icon name={entry.icon} color={active ? c.text : c.icon} />
                  <Text numberOfLines={1} style={[type.chrome, { flex: 1, color: active ? c.text : c.soft }]}>
                    {entry.label}
                  </Text>
                  {hinted && <StatusDot tone="amber" />}
                  {compact && active && <Icon name="check" color={c.icon} />}
                </Pressable>
              );
            })}
          </View>
        );
      })}
      {!shown.length && <Text style={[type.chrome, { color: c.muted }]}>No setting matches “{query}”.</Text>}
      {!!catalog.error && (
        <View style={{ gap: 8 }}>
          <Notice error>Could not check available settings. Check your connection and retry.</Notice>
          <Button title="Retry" onPress={() => void catalog.retry().catch(() => {})} />
        </View>
      )}
      <Text style={[type.meta, { color: c.muted, paddingHorizontal: 10 }]}>Canopy {CANOPY_VERSION}</Text>
    </SettingsScroll>
  );
}
