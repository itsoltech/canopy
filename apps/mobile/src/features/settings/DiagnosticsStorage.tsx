import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import {
  storageComponents,
  storageDisplay,
  storageHelp,
  storageTotalsHelp,
  storageDatabaseHelp,
  type StorageComponent,
} from "@canopy/domain/diagnostics";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { EvidenceRows } from "./DiagnosticsMeasures";
import { useDateTime } from "./display";
import { styles, useColors } from "../../ui/theme";

function Component({ component }: { component: StorageComponent }) {
  const c = useColors();
  const dateTime = useDateTime();
  const display = storageDisplay(component);

  return (
    <SettingsRow title={component.name}>
      {component.kind || display.status ? (
        <Text accessibilityLiveRegion="polite" style={[styles.workMeta, { color: c.muted }]}>
          {[component.kind, display.status].filter(Boolean).join(" · ")}
        </Text>
      ) : null}
      <EvidenceRows rows={[[display.totalLabel, display.total]]} />
      {display.freshness ? (
        <Text style={[styles.workMeta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
          {display.showDate
            ? `${display.sampleAction} ${dateTime(display.sampledAtMs / 1000n)}${component.ageUncertain ? " · Age is approximate" : ""}`
            : display.freshness}
        </Text>
      ) : null}
      {display.categories.length ? <EvidenceRows rows={display.categories} /> : null}
      {display.database ? (
        <View style={{ gap: 4 }}>
          <EvidenceRows rows={[["Database", display.database]]} />
          <Text style={[styles.workMeta, { color: c.muted }]}>{storageDatabaseHelp}</Text>
        </View>
      ) : null}
      {display.note ? <Text style={[styles.workMeta, { color: c.muted }]}>{display.note}</Text> : null}
      {display.message ? <Text style={[styles.workMeta, { color: c.muted }]}>{display.message}</Text> : null}
    </SettingsRow>
  );
}

export function DiagnosticsStorage({ computers }: { computers: ui.ComputerDiagnostics[] }) {
  const c = useColors();

  if (!computers.length) return null;

  return (
    <View style={{ minWidth: 0, gap: 12 }}>
      <Text accessibilityRole="header" style={[styles.label, { color: c.text }]}>
        Canopy storage
      </Text>
      <Text style={[styles.workMeta, { color: c.muted }]}>{storageHelp}</Text>
      <Text style={[styles.workMeta, { color: c.muted }]}>{storageTotalsHelp}</Text>
      {computers.map((computer) => (
        <SettingsGroup key={computer.computerId} title={computer.name}>
          {storageComponents(computer).map((component) => (
            <Component key={component.id} component={component} />
          ))}
        </SettingsGroup>
      ))}
    </View>
  );
}
