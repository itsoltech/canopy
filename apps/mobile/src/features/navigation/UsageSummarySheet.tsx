import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import type { UsageSummaryNote, UsageSummaryRow as Row } from "@canopy/domain/usage-summary";
import { Button } from "../../ui/Button";
import { Overlay } from "../../ui/Overlay";
import { SheetCloseButton, SheetDragArea } from "../../ui/SheetDragArea";
import { styles, useColors } from "../../ui/theme";
import { useOpenSettingsSection } from "../settings/navigation";
import { useUsageTypography } from "../providers/usage-typography";
import { UsageSummaryRow } from "./UsageSummaryRow";

/** Full phone width and the shared tablet card, with only the readings scrolling. */
export function UsageSummarySheet({
  open,
  onClose,
  rows,
  notes,
  now,
}: {
  open: boolean;
  onClose: () => void;
  rows: readonly Row[];
  notes: readonly UsageSummaryNote[];
  now: number;
}) {
  const c = useColors();
  const type = useUsageTypography();
  const openSettingsSection = useOpenSettingsSection();
  const { height } = useWindowDimensions();

  function settings(section: "providers" | "proxies") {
    onClose();
    openSettingsSection(section);
  }

  return (
    <Overlay visible={open} onClose={onClose} label="Provider usage">
      <View style={{ padding: 12, gap: 12, minHeight: 0, flexShrink: 1 }}>
        <SheetDragArea style={[styles.row, { justifyContent: "space-between" }]}>
          <Text accessibilityRole="header" style={[type.section, { color: c.muted, flex: 1 }]}>
            Provider usage
          </Text>
          <SheetCloseButton label="Close provider usage" />
        </SheetDragArea>
        <ScrollView
          style={{ maxHeight: Math.min(384, height * 0.5), minHeight: 0, flexGrow: 0, flexShrink: 1 }}
          contentContainerStyle={{ gap: 12 }}
          nestedScrollEnabled
          bounces={false}
        >
          {rows.map((row) => (
            <UsageSummaryRow key={row.provider} row={row} now={now} />
          ))}
          {!rows.length && !notes.length ? (
            <Text style={[type.meta, { color: c.muted }]}>No limit readings yet.</Text>
          ) : null}
          {notes.map((note) => (
            <View key={note.proxyId} style={{ gap: 4 }}>
              <Text accessibilityLiveRegion={note.checking ? "polite" : "none"} style={[type.meta, { color: c.muted }]}>
                {note.text}
              </Text>
              {note.checking ? null : (
                <Button title="Check proxy settings" variant="text" size="sm" onPress={() => settings("proxies")} />
              )}
            </View>
          ))}
        </ScrollView>
        <Button
          title="Open provider settings"
          variant="ghost"
          size="sm"
          style={{ justifyContent: "flex-start" }}
          onPress={() => settings("providers")}
        />
      </View>
    </Overlay>
  );
}
