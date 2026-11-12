import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { SettingsGroup } from "./SettingsGroup";
import { DiagnosticsMeasures } from "./DiagnosticsMeasures";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { clientGroups } from "@canopy/domain/diagnostics";
import { styles, useColors } from "../../ui/theme";

export function DiagnosticsClients({ computer }: { computer: ui.ComputerDiagnostics }) {
  const c = useColors();

  if (!computer.detailsAvailable) return null;

  return (
    <SettingsGroup title="Clients and delivery" description={computer.name}>
      <View style={{ gap: 8 }}>
        <Text style={[styles.workMeta, { color: c.muted }]}>
          Untrusted client observations: 10% of openings, up to 20/min. BFF operations are measured separately.
        </Text>
        <Text style={[styles.workMeta, { color: c.muted }]}>
          Paint and JS frame delays are proxies. Unsupported timings are absent; samples are not total activity.
        </Text>
        {computer.clientMeasures.length ? (
          clientGroups(computer.clientMeasures).map((group) => (
            <SettingsDisclosure key={group.source} title={group.title} initiallyOpen={group.source === "bff"}>
              <DiagnosticsMeasures measures={group.measures} />
            </SettingsDisclosure>
          ))
        ) : (
          <Text style={[styles.workMeta, { color: c.muted }]}>No client observations in this window.</Text>
        )}
      </View>
    </SettingsGroup>
  );
}
